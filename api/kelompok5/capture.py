#!/usr/bin/env python3
"""
==============================================================================
VERCEL PYTHON SERVERLESS FUNCTION: POST /api/kelompok5/capture
Project: Monitor Pertumbuhan Selada Keriting (Lactuca sativa L. var. crispa)
Kelompok 5

Responsibilities:
  - Preserves 100% of the ESP32-CAM autonomous HTTP upload contract:
      * Endpoint: POST /api/kelompok5/capture
      * Headers: Content-Type (image/jpeg), X-Kelompok, X-Slot-Key,
        X-Captured-At, X-HST-Day, X-File-Size, X-Checksum-FNV1A
      * Validations: Fail-closed authentication (CAPTURE_SHARED_TOKEN),
        payload bounds (100 B .. 4.5 MB Vercel limit), JPEG magic bytes
        (\xff\xd8\xff), exact byte size, 32-bit FNV-1a checksum, genuine
        calendar date & WIB schedule window (07:00-16:50, 10-min grid),
        X-Slot-Key vs X-Captured-At consistency, X-HST-Day bounds (1..42),
        and image pixel dimension bounds (64x64 .. 1600x1200) prior to CV.
      * Confirmation semantics: Returns HTTP 200 with
        {"ok": true, "confirmed": true, ...} ONLY after CV processing,
        idempotent Vercel Blob uploads (orig, mask, overlay), and fenced
        Firebase RTDB metadata + slot confirmation all succeed.
  - Ephemeral /tmp storage only (automatically cleaned up per invocation).
  - Atomic slot deduplication, monotonic fencing token + owner_id verification,
    and fenced failure rollback in Firebase RTDB using mandatory HTTP ETag
    Compare-And-Swap (X-Firebase-ETag / If-Match).
==============================================================================
"""

import os
import re
import sys
import uuid
import hmac
import json
import time
import warnings
import urllib.request
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler
from datetime import datetime
from io import BytesIO
from PIL import Image

# Ensure repository root and scripts/ are importable in Vercel Python runtime
_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_CURRENT_DIR, "..", ".."))
_SCRIPTS_DIR = os.path.join(_REPO_ROOT, "scripts")
for _p in (_REPO_ROOT, _SCRIPTS_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from growth_cv_pipeline import LettuceCVPipeline, WIB_TIMEZONE

# ----------------------------------------------------------------------------
# Constants & Hardened Limits
# ----------------------------------------------------------------------------
MIN_PAYLOAD_BYTES = 100
# Vercel Serverless Function request body hard limit is 4.5 MB
MAX_PAYLOAD_BYTES = 4_500_000

# Image dimension bounds (OV2640 max UXGA is 1600x1200; prevents decompression bombs)
MIN_IMAGE_WIDTH = 64
MIN_IMAGE_HEIGHT = 64
MAX_IMAGE_WIDTH = 1600
MAX_IMAGE_HEIGHT = 1200
MAX_IMAGE_PIXELS = MAX_IMAGE_WIDTH * MAX_IMAGE_HEIGHT
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

# Schedule & Timestamp Constants (42-day campaign, 07:00-16:50 WIB every 10 mins)
SLOT_KEY_REGEX = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}:\d{2}$")
FNV1A_HEX_REGEX = re.compile(r"^[0-9a-fA-F]{8}$")
SCHEDULE_START_MINUTES = 7 * 60       # 07:00 WIB (420)
SCHEDULE_END_MINUTES = 16 * 60 + 50   # 16:50 WIB (1010)
SCHEDULE_INTERVAL_MINUTES = 10
SLOT_TIMESTAMP_TOLERANCE_MS = 10 * 60 * 1000  # 10 minutes
MIN_VALID_EPOCH_MS = 1704067200000    # 2024-01-01T00:00:00Z
MAX_VALID_EPOCH_MS = 2524608000000    # 2050-01-01T00:00:00Z

# Timeout & Lease Alignment (ESP32-CAM HTTP timeout is 12,000 ms; Vercel maxDuration is 15s)
DEFAULT_REQUEST_DEADLINE_SECONDS = 9.5
DEFAULT_HTTP_SOCKET_TIMEOUT_SECONDS = 3.5
DEFAULT_SLOT_LEASE_TTL_MS = 15_000    # 15s lease (> 9.5s execution deadline)
DEFAULT_BLOB_API_VERSION = "7"


class MissingETagError(RuntimeError):
    """Raised when Firebase RTDB does not return a required ETag for CAS."""


class StaleLockOwnerError(RuntimeError):
    """Raised when a worker's slot lock ownership or fence token was superseded."""


def compute_fnv1a_hex(data_bytes):
    """Computes 32-bit FNV-1a hash matching ESP32-CAM firmware implementation."""
    h = 2166136261
    for b in data_bytes:
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return f"{h:08x}"


def sanitize_rtdb_key(slot_key):
    """Converts slot key 'YYYY-MM-DD_HH:MM' into Firebase RTDB safe key."""
    return re.sub(r"[.#$\[\]/:]", "-", str(slot_key).strip())


def format_slot_key_from_dt(dt_wib, interval_minutes=SCHEDULE_INTERVAL_MINUTES):
    minute_bucket = (dt_wib.minute // interval_minutes) * interval_minutes
    return f"{dt_wib.strftime('%Y-%m-%d')}_{dt_wib.hour:02d}:{minute_bucket:02d}"


def parse_and_validate_slot_key(slot_key_str):
    """
    Validates that `slot_key_str` matches 'YYYY-MM-DD_HH:MM', represents a real
    calendar date, and falls within the 07:00-16:50 WIB 10-minute schedule grid.
    Returns `(is_valid, slot_dt_wib, error_msg)`.
    """
    if not slot_key_str or not isinstance(slot_key_str, str):
        return False, None, "Missing X-Slot-Key header"
    clean_slot = slot_key_str.strip()
    if not SLOT_KEY_REGEX.match(clean_slot):
        return (
            False,
            None,
            f"Invalid X-Slot-Key format '{clean_slot}' (expected YYYY-MM-DD_HH:MM)",
        )
    try:
        naive_dt = datetime.strptime(clean_slot, "%Y-%m-%d_%H:%M")
    except ValueError as exc:
        return False, None, f"Invalid calendar date/time in X-Slot-Key '{clean_slot}': {exc}"

    slot_dt_wib = naive_dt.replace(tzinfo=WIB_TIMEZONE)
    total_minutes = slot_dt_wib.hour * 60 + slot_dt_wib.minute
    if total_minutes < SCHEDULE_START_MINUTES or total_minutes > SCHEDULE_END_MINUTES:
        return (
            False,
            None,
            f"X-Slot-Key '{clean_slot}' is outside daily capture window (07:00-16:50 WIB)",
        )
    if (slot_dt_wib.minute % SCHEDULE_INTERVAL_MINUTES) != 0:
        return (
            False,
            None,
            f"X-Slot-Key '{clean_slot}' minute must be a multiple of 10",
        )
    return True, slot_dt_wib, None


# ----------------------------------------------------------------------------
# Vercel Blob Storage Adapter (Idempotent Overwrite + Fenced Cleanup)
# ----------------------------------------------------------------------------
class VercelBlobStorage:
    """
    Uploads CV image artifacts (orig.jpg, mask.png, overlay.jpg) to Vercel Blob
    using deterministic pathnames with explicit overwrite (`x-allow-overwrite: 1`,
    `x-add-random-suffix: 0`) and supports deleting partial artifacts on rollback.
    """

    def __init__(
        self,
        token=None,
        api_base_url=None,
        api_version=None,
        timeout_seconds=DEFAULT_HTTP_SOCKET_TIMEOUT_SECONDS,
        urlopen_fn=None,
    ):
        self.token = (
            token
            if token is not None
            else os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()
        )
        self.api_base_url = (
            api_base_url
            or os.environ.get("BLOB_API_BASE_URL", "https://blob.vercel-storage.com").strip()
        ).rstrip("/")
        self.api_version = (
            api_version
            or os.environ.get("BLOB_API_VERSION", DEFAULT_BLOB_API_VERSION).strip()
            or DEFAULT_BLOB_API_VERSION
        )
        self.timeout_seconds = float(timeout_seconds)
        self._urlopen = urlopen_fn or urllib.request.urlopen

    def is_configured(self):
        return bool(self.token)

    def put_bytes(self, pathname, data_bytes, content_type, timeout=None):
        if not self.token:
            raise RuntimeError("Missing BLOB_READ_WRITE_TOKEN environment variable")

        clean_path = str(pathname).lstrip("/")
        url = f"{self.api_base_url}/{clean_path}"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "x-api-version": str(self.api_version),
            "x-content-type": content_type,
            "x-add-random-suffix": "0",
            "x-allow-overwrite": "1",
            "x-cache-control-max-age": "31536000",
            "Content-Type": content_type,
            "Content-Length": str(len(data_bytes)),
        }
        req = urllib.request.Request(url, data=data_bytes, headers=headers, method="PUT")
        effective_timeout = float(timeout if timeout is not None else self.timeout_seconds)
        try:
            with self._urlopen(req, timeout=effective_timeout) as resp:
                raw_resp = resp.read().decode("utf-8")
                parsed = json.loads(raw_resp) if raw_resp else {}
                blob_url = parsed.get("url")
                if not blob_url:
                    raise RuntimeError("Vercel Blob response missing 'url'")
                return blob_url
        except urllib.error.HTTPError as exc:
            err_body = ""
            try:
                err_body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            finally:
                try:
                    exc.close()
                except Exception:
                    pass
            raise RuntimeError(f"Vercel Blob PUT failed (HTTP {exc.code}): {err_body[:160] or exc.reason}") from exc
        except Exception as exc:
            raise RuntimeError(f"Vercel Blob PUT error: {exc}") from exc

    def delete_blobs(self, blob_urls, timeout=None):
        """
        Best-effort deletion of partial blob URLs created during a failed attempt.
        """
        urls_list = [u for u in (blob_urls or []) if u]
        if not urls_list or not self.token:
            return False

        url = f"{self.api_base_url}/delete"
        payload_bytes = json.dumps({"urls": urls_list}).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self.token}",
            "x-api-version": str(self.api_version),
            "Content-Type": "application/json",
            "Content-Length": str(len(payload_bytes)),
        }
        req = urllib.request.Request(url, data=payload_bytes, headers=headers, method="POST")
        effective_timeout = float(timeout if timeout is not None else self.timeout_seconds)
        try:
            with self._urlopen(req, timeout=effective_timeout) as resp:
                _ = resp.read()
                return 200 <= resp.status < 300
        except urllib.error.HTTPError as exc:
            try:
                exc.close()
            except Exception:
                pass
            return False
        except Exception:
            return False

    def upload_cv_artifacts(self, slot_key, image_id, artifacts_dict, timeout_getter=None):
        """
        Uploads orig, mask, and overlay artifacts for a given slot and returns
        their public HTTPS Blob URLs. Tracks partial uploads on failure so the
        caller can clean them up safely if it still holds the slot fence.
        """
        safe_slot = sanitize_rtdb_key(slot_key)
        prefix = f"kelompok5/growth_images/{safe_slot}"
        uploaded_urls = []

        try:
            for key_name, field_name in (
                ("orig", "image_url"),
                ("mask", "mask_url"),
                ("overlay", "overlay_url"),
            ):
                fname, fbytes, fct = artifacts_dict[key_name]
                t_out = timeout_getter() if callable(timeout_getter) else self.timeout_seconds
                url = self.put_bytes(f"{prefix}/{fname}", fbytes, fct, timeout=t_out)
                uploaded_urls.append((field_name, url))
        except Exception as exc:
            exc.uploaded_urls = [u for _, u in uploaded_urls]
            raise

        result = {field: url for field, url in uploaded_urls}
        result["_uploaded_urls"] = [u for _, u in uploaded_urls]
        return result


# ----------------------------------------------------------------------------
# Firebase Realtime Database Atomic Store (Mandatory ETag CAS + Fencing Token)
# ----------------------------------------------------------------------------
class FirebaseRTDBStore:
    """
    Persists CV growth metadata and enforces atomic per-slot deduplication in
    Firebase Realtime Database using mandatory REST ETag Compare-And-Swap
    (X-Firebase-ETag + If-Match) and monotonic fencing tokens (`fence_token` +
    `owner_id`).
    """

    def __init__(
        self,
        db_url=None,
        auth_token=None,
        access_token=None,
        namespace="kelompok5",
        lease_ttl_ms=DEFAULT_SLOT_LEASE_TTL_MS,
        timeout_seconds=DEFAULT_HTTP_SOCKET_TIMEOUT_SECONDS,
        urlopen_fn=None,
    ):
        raw_url = (
            db_url
            if db_url is not None
            else os.environ.get("FIREBASE_RTDB_URL", "").strip()
        )
        self.db_url = raw_url.rstrip("/")
        self.access_token = (
            access_token
            if access_token is not None
            else os.environ.get("FIREBASE_ACCESS_TOKEN", "").strip()
        )
        self.auth_token = (
            auth_token
            if auth_token is not None
            else (
                os.environ.get("FIREBASE_AUTH_TOKEN", "").strip()
                or os.environ.get("FIREBASE_DB_SECRET", "").strip()
            )
        )
        self.namespace = namespace.strip("/")
        self.lease_ttl_ms = int(lease_ttl_ms)
        self.timeout_seconds = float(timeout_seconds)
        self._urlopen = urlopen_fn or urllib.request.urlopen

    def is_configured(self):
        return bool(self.db_url)

    def _build_url(self, rel_path):
        if not self.db_url:
            raise RuntimeError("Missing FIREBASE_RTDB_URL environment variable")
        clean_rel = str(rel_path).lstrip("/")
        url = f"{self.db_url}/{self.namespace}/{clean_rel}.json"
        if self.auth_token and not self.access_token:
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}auth={urllib.parse.quote(self.auth_token, safe='')}"
        return url

    def _request_json(self, method, rel_path, payload=None, extra_headers=None, timeout=None):
        url = self._build_url(rel_path)
        headers = {"Accept": "application/json"}
        if self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        if extra_headers:
            headers.update(extra_headers)
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        effective_timeout = float(timeout if timeout is not None else self.timeout_seconds)
        with self._urlopen(req, timeout=effective_timeout) as resp:
            raw = resp.read().decode("utf-8")
            etag = resp.headers.get("ETag") or resp.headers.get("etag")
            body = json.loads(raw) if raw else None
            return resp.status, body, etag

    @staticmethod
    def _require_etag(etag, context_msg):
        if not etag or not str(etag).strip():
            raise MissingETagError(
                f"Firebase RTDB did not return a required ETag header during {context_msg}; aborting CAS operation"
            )
        return str(etag).strip()

    @staticmethod
    def _verify_active_lock_ownership(current_state, lock_record):
        """
        Returns True ONLY if `current_state` in RTDB is still PROCESSING and matches
        both `owner_id` and `fence_token` from `lock_record`.
        """
        if not isinstance(current_state, dict) or not isinstance(lock_record, dict):
            return False
        if current_state.get("status") != "PROCESSING":
            return False
        expected_owner = lock_record.get("owner_id")
        expected_fence = lock_record.get("fence_token")
        if not expected_owner or expected_fence is None:
            return False
        return (
            current_state.get("owner_id") == expected_owner
            and int(current_state.get("fence_token") or -1) == int(expected_fence)
        )

    def claim_slot(self, slot_key, fnv1a, owner_id=None, now_ms=None, timeout=None):
        """
        Atomically claims `slot_key` for processing using mandatory Firebase RTDB
        ETag CAS and assigns a unique `owner_id` + monotonic `fence_token`.
        Returns tuple `(status_code, slot_state)`:
          - ("CONFIRMED", existing_record): Slot was already confirmed earlier.
          - ("CLAIMED", lock_record): Caller exclusively holds the PROCESSING lock.
          - ("IN_PROGRESS", existing_record): Another active invocation holds the lock.
        """
        now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
        owner_id = str(owner_id or uuid.uuid4().hex)
        safe_key = sanitize_rtdb_key(slot_key)
        slot_path = f"executed_slots/{safe_key}"

        try:
            _, current_state, raw_etag = self._request_json(
                "GET",
                slot_path,
                extra_headers={"X-Firebase-ETag": "true"},
                timeout=timeout,
            )
        except urllib.error.HTTPError as exc:
            code = exc.code
            try:
                exc.close()
            except Exception:
                pass
            raise RuntimeError(f"Firebase RTDB slot GET failed (HTTP {code})") from exc
        except Exception as exc:
            raise RuntimeError(f"Firebase RTDB slot GET error: {exc}") from exc

        etag = self._require_etag(raw_etag, f"claim_slot GET ({slot_key})")

        prev_fence = 0
        if isinstance(current_state, dict):
            prev_fence = int(current_state.get("fence_token") or 0)
            state_status = current_state.get("status")
            if state_status == "CONFIRMED":
                return "CONFIRMED", current_state

            if state_status == "PROCESSING":
                locked_at = int(current_state.get("locked_at") or 0)
                if (now_ms - locked_at) < self.lease_ttl_ms:
                    return "IN_PROGRESS", current_state

        next_fence = prev_fence + 1
        lock_payload = {
            "status": "PROCESSING",
            "slot_key": slot_key,
            "owner_id": owner_id,
            "fence_token": next_fence,
            "fnv1a": fnv1a,
            "locked_at": now_ms,
            "lease_expires_at": now_ms + self.lease_ttl_ms,
        }

        try:
            _, _, put_etag = self._request_json(
                "PUT",
                slot_path,
                payload=lock_payload,
                extra_headers={"If-Match": etag},
                timeout=timeout,
            )
            claimed_record = dict(lock_payload)
            if put_etag:
                claimed_record["_etag"] = str(put_etag).strip()
            return "CLAIMED", claimed_record
        except urllib.error.HTTPError as exc:
            code = exc.code
            err_body = ""
            try:
                err_body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            finally:
                try:
                    exc.close()
                except Exception:
                    pass
            if code == 412:
                # Another concurrent request mutated the slot first; inspect winner state
                winner_state = None
                if err_body:
                    try:
                        winner_state = json.loads(err_body)
                    except Exception:
                        winner_state = None
                if not isinstance(winner_state, dict):
                    try:
                        _, winner_state, _ = self._request_json("GET", slot_path, timeout=timeout)
                    except Exception:
                        winner_state = {}
                if isinstance(winner_state, dict) and winner_state.get("status") == "CONFIRMED":
                    return "CONFIRMED", winner_state
                return "IN_PROGRESS", winner_state if isinstance(winner_state, dict) else {}
            raise RuntimeError(f"Firebase RTDB slot claim PUT failed (HTTP {code})") from exc
        except Exception as exc:
            raise RuntimeError(f"Firebase RTDB slot claim PUT error: {exc}") from exc

    def commit_slot_and_metadata(self, slot_key, lock_record, metadata_record, now_ms=None, timeout=None):
        """
        Verifies active lock ownership & fencing token via mandatory ETag GET,
        writes growth metadata, and transitions the slot to CONFIRMED via
        conditional `If-Match` PUT.
        If ownership was lost or superseded, aborts without overwriting the new
        owner's metadata or slot state.
        """
        now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
        safe_key = sanitize_rtdb_key(slot_key)
        meta_path = f"growth_metadata/{safe_key}"
        slot_path = f"executed_slots/{safe_key}"

        # 1. Re-fetch current slot lock and ETag to verify active ownership & fence
        try:
            _, current_slot, raw_etag = self._request_json(
                "GET",
                slot_path,
                extra_headers={"X-Firebase-ETag": "true"},
                timeout=timeout,
            )
        except urllib.error.HTTPError as exc:
            code = exc.code
            try:
                exc.close()
            except Exception:
                pass
            raise RuntimeError(f"Firebase RTDB pre-commit slot GET failed (HTTP {code})") from exc

        slot_etag = self._require_etag(raw_etag, f"commit_slot GET ({slot_key})")

        if not self._verify_active_lock_ownership(current_slot, lock_record):
            raise StaleLockOwnerError(
                f"Cannot commit slot {slot_key}: lock ownership ({lock_record.get('owner_id')}, "
                f"fence={lock_record.get('fence_token')}) was superseded"
            )

        locked_at = int(current_slot.get("locked_at") or 0)
        if (now_ms - locked_at) >= self.lease_ttl_ms:
            raise StaleLockOwnerError(
                f"Cannot commit slot {slot_key}: processing lease ({self.lease_ttl_ms}ms) expired before commit"
            )

        # 2. Write metadata annotated with owner_id and fence_token
        fenced_meta = dict(metadata_record)
        fenced_meta["owner_id"] = lock_record["owner_id"]
        fenced_meta["fence_token"] = int(lock_record["fence_token"])

        try:
            self._request_json("PUT", meta_path, payload=fenced_meta, timeout=timeout)
        except urllib.error.HTTPError as exc:
            code = exc.code
            try:
                exc.close()
            except Exception:
                pass
            raise RuntimeError(f"Firebase RTDB metadata PUT failed (HTTP {code})") from exc
        except Exception as exc:
            raise RuntimeError(f"Firebase RTDB metadata PUT error: {exc}") from exc

        # 3. Conditionally transition slot state from PROCESSING -> CONFIRMED using If-Match
        confirmed_payload = {
            "status": "CONFIRMED",
            "slot_key": slot_key,
            "owner_id": lock_record["owner_id"],
            "fence_token": int(lock_record["fence_token"]),
            "confirmed_at": now_ms,
            "image_id": fenced_meta.get("image_id", ""),
            "file_size": fenced_meta.get("file_size", 0),
            "fnv1a": fenced_meta.get("fnv1a", ""),
            "checksum_fnv1a": fenced_meta.get("fnv1a", ""),
            "quality_status": fenced_meta.get("quality_status", "VALID"),
            "image_url": fenced_meta.get("image_url", ""),
            "mask_url": fenced_meta.get("mask_url", ""),
            "overlay_url": fenced_meta.get("overlay_url", ""),
        }

        try:
            self._request_json(
                "PUT",
                slot_path,
                payload=confirmed_payload,
                extra_headers={"If-Match": slot_etag},
                timeout=timeout,
            )
        except urllib.error.HTTPError as exc:
            code = exc.code
            try:
                exc.close()
            except Exception:
                pass
            if code == 412:
                raise StaleLockOwnerError(
                    f"Slot confirmation CAS failed (HTTP 412) for {slot_key}: lock superseded"
                ) from exc
            # Best-effort cleanup of unconfirmed metadata while we still hold the lock
            try:
                self._request_json("DELETE", meta_path, timeout=timeout)
            except Exception:
                pass
            raise RuntimeError(f"Firebase RTDB slot confirmation PUT failed (HTTP {code})") from exc
        except Exception as exc:
            try:
                self._request_json("DELETE", meta_path, timeout=timeout)
            except Exception:
                pass
            raise RuntimeError(f"Firebase RTDB slot confirmation PUT error: {exc}") from exc

        return confirmed_payload

    def release_failed_slot(self, slot_key, lock_record, error_reason, now_ms=None, timeout=None):
        """
        Conditionally rolls back a PROCESSING slot lock to FAILED using ETag
        `If-Match` ONLY if `lock_record` (`owner_id` + `fence_token`) still
        owns the active lock.
        Returns True if rolled back by this owner, False if superseded or failed.
        """
        if not isinstance(lock_record, dict):
            return False

        now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
        safe_key = sanitize_rtdb_key(slot_key)
        slot_path = f"executed_slots/{safe_key}"

        try:
            _, current_slot, raw_etag = self._request_json(
                "GET",
                slot_path,
                extra_headers={"X-Firebase-ETag": "true"},
                timeout=timeout,
            )
            slot_etag = self._require_etag(raw_etag, f"release_failed_slot GET ({slot_key})")
        except Exception:
            return False

        if not self._verify_active_lock_ownership(current_slot, lock_record):
            return False

        rollback_payload = {
            "status": "FAILED",
            "slot_key": slot_key,
            "owner_id": lock_record["owner_id"],
            "fence_token": int(lock_record["fence_token"]),
            "failed_at": now_ms,
            "error": str(error_reason)[:240],
        }
        try:
            self._request_json(
                "PUT",
                slot_path,
                payload=rollback_payload,
                extra_headers={"If-Match": slot_etag},
                timeout=timeout,
            )
            return True
        except urllib.error.HTTPError as exc:
            try:
                exc.close()
            except Exception:
                pass
            return False
        except Exception:
            return False


# ----------------------------------------------------------------------------
# Serverless Capture Ingestor
# ----------------------------------------------------------------------------
class ServerlessCaptureIngestor:
    """
    Stateless serverless ingestor that coordinates fail-closed authentication,
    strict header/calendar/dimension validation, Firebase RTDB fenced ETag CAS
    slot locking, ephemeral /tmp CV processing, idempotent Vercel Blob upload,
    and fenced rollback + partial artifact cleanup.
    """

    def __init__(
        self,
        blob_storage=None,
        rtdb_store=None,
        cv_pipeline=None,
        shared_token=None,
        request_deadline_seconds=DEFAULT_REQUEST_DEADLINE_SECONDS,
        plant_id="SLD-01",
        camera_id="ESP32-CAM-01",
    ):
        self.blob_storage = blob_storage or VercelBlobStorage()
        self.rtdb_store = rtdb_store or FirebaseRTDBStore()
        self.cv_pipeline = cv_pipeline or LettuceCVPipeline(
            use_tmp_only=True,
            calib_factor_mm_per_px=self._parse_calib_env(),
        )
        self.shared_token = (
            shared_token.strip()
            if isinstance(shared_token, str)
            else os.environ.get("CAPTURE_SHARED_TOKEN", "").strip()
        )
        self.request_deadline_seconds = float(request_deadline_seconds)
        self.plant_id = plant_id
        self.camera_id = camera_id

    @staticmethod
    def _parse_calib_env():
        raw = os.environ.get("CALIB_FACTOR_MM_PER_PX", "").strip()
        if not raw:
            return None
        try:
            val = float(raw)
            return val if val > 0 else None
        except ValueError:
            return None

    @staticmethod
    def _get_header(headers, name):
        if not headers:
            return None
        val = headers.get(name)
        if val is not None:
            return val
        lower_name = name.lower()
        for k, v in headers.items():
            if k.lower() == lower_name:
                return v
        return None

    def verify_auth_headers(self, headers):
        """
        Fail-closed verification of CAPTURE_SHARED_TOKEN using constant-time
        comparison:
          - Returns (False, 503, ...) if CAPTURE_SHARED_TOKEN is empty/unset.
          - Returns (False, 401, ...) if request token is missing or invalid.
          - Returns (True, 200, None) when token is valid.
        """
        if not self.shared_token:
            return (
                False,
                503,
                "Server authentication not configured: missing CAPTURE_SHARED_TOKEN",
            )

        h = headers or {}
        candidate = (
            self._get_header(h, "X-Capture-Token")
            or self._get_header(h, "X-Camera-Token")
            or ""
        ).strip()

        if not candidate:
            auth_hdr = (self._get_header(h, "Authorization") or "").strip()
            if auth_hdr.lower().startswith("bearer "):
                candidate = auth_hdr[7:].strip()

        if not candidate:
            return False, 401, "Unauthorized: missing capture authentication token"

        if not hmac.compare_digest(candidate.encode("utf-8"), self.shared_token.encode("utf-8")):
            return False, 401, "Unauthorized: invalid capture authentication token"

        return True, 200, None

    def ingest(
        self,
        raw_bytes,
        headers=None,
        expected_size=None,
        expected_fnv1a=None,
        captured_at_ms=None,
        slot_key=None,
        hst_day=None,
        file_name="wifi-camera-upload.jpg",
    ):
        """
        Executes fail-closed authentication, strict header/payload/calendar/pixel
        validation, fenced Firebase RTDB ETag CAS slot locking, ephemeral /tmp CV
        pipeline, idempotent Vercel Blob upload, and fenced rollback.
        Returns `(http_status, response_dict)`.
        """
        start_monotonic = time.monotonic()
        hdrs = headers or {}

        def _remaining_timeout():
            elapsed = time.monotonic() - start_monotonic
            rem = self.request_deadline_seconds - elapsed
            if rem <= 0.05:
                raise TimeoutError(
                    f"Serverless execution deadline ({self.request_deadline_seconds}s) exceeded"
                )
            return min(DEFAULT_HTTP_SOCKET_TIMEOUT_SECONDS, rem)

        # 1. Fail-Closed Endpoint Authentication (503 if token unconfigured, 401 if invalid)
        auth_ok, auth_status, auth_err = self.verify_auth_headers(hdrs)
        if not auth_ok:
            return auth_status, {"ok": False, "confirmed": False, "error": auth_err}

        # 2. Content-Type & X-Kelompok Header Validation
        content_type_hdr = self._get_header(hdrs, "Content-Type")
        if content_type_hdr is not None:
            ct_clean = str(content_type_hdr).split(";", 1)[0].strip().lower()
            if ct_clean != "image/jpeg":
                return 422, {
                    "ok": False,
                    "confirmed": False,
                    "error": f"Invalid Content-Type '{content_type_hdr}' (expected image/jpeg)",
                }

        kelompok_hdr = self._get_header(hdrs, "X-Kelompok")
        if kelompok_hdr is not None and str(kelompok_hdr).strip() != "Kelompok 5":
            return 422, {
                "ok": False,
                "confirmed": False,
                "error": f"Invalid X-Kelompok header '{kelompok_hdr}' (expected 'Kelompok 5')",
            }

        # 3. Payload Size & Bounds Validation (100B .. 4.5MB Vercel limit)
        if not raw_bytes or not isinstance(raw_bytes, (bytes, bytearray)):
            return 422, {"ok": False, "confirmed": False, "error": "Empty or truncated payload"}

        actual_size = len(raw_bytes)
        if actual_size < MIN_PAYLOAD_BYTES:
            return 422, {"ok": False, "confirmed": False, "error": "Empty or truncated payload"}
        if actual_size > MAX_PAYLOAD_BYTES:
            return 413, {
                "ok": False,
                "confirmed": False,
                "error": f"Payload size {actual_size} exceeds 4.5MB serverless limit ({MAX_PAYLOAD_BYTES} bytes)",
            }

        # 4. JPEG Magic Bytes Validation
        if bytes(raw_bytes[:3]) != b"\xff\xd8\xff":
            return 422, {"ok": False, "confirmed": False, "error": "Payload is not a JPEG image"}

        # 5. Mandatory Exact File Size Header Match (X-File-Size)
        raw_expected_size = (
            expected_size
            if expected_size is not None
            else self._get_header(hdrs, "X-File-Size")
        )
        if raw_expected_size is None or str(raw_expected_size).strip() == "":
            return 422, {"ok": False, "confirmed": False, "error": "Missing required X-File-Size header"}
        try:
            exp_size_int = int(str(raw_expected_size).strip())
        except ValueError:
            return 422, {"ok": False, "confirmed": False, "error": f"Invalid X-File-Size header: {raw_expected_size}"}
        if exp_size_int != actual_size:
            return 422, {
                "ok": False,
                "confirmed": False,
                "error": f"Size mismatch: expected {exp_size_int}, got {actual_size}",
            }

        # 6. Mandatory 32-bit FNV-1a Checksum Match (X-Checksum-FNV1A)
        target_fnv1a = (
            expected_fnv1a
            if expected_fnv1a is not None
            else self._get_header(hdrs, "X-Checksum-FNV1A")
        )
        if target_fnv1a is None or str(target_fnv1a).strip() == "":
            return 422, {"ok": False, "confirmed": False, "error": "Missing required X-Checksum-FNV1A header"}
        clean_target_fnv1a = str(target_fnv1a).strip().lower()
        if not FNV1A_HEX_REGEX.match(clean_target_fnv1a):
            return 422, {
                "ok": False,
                "confirmed": False,
                "error": f"Invalid X-Checksum-FNV1A format '{target_fnv1a}' (expected 8 hex chars)",
            }
        actual_fnv1a = compute_fnv1a_hex(raw_bytes)
        if clean_target_fnv1a != actual_fnv1a:
            return 422, {
                "ok": False,
                "confirmed": False,
                "error": f"FNV1a checksum mismatch: expected {clean_target_fnv1a}, got {actual_fnv1a}",
            }

        # 7. Mandatory Timestamp, Genuine Calendar Date, WIB Window, & Slot Consistency
        raw_ts = (
            captured_at_ms
            if captured_at_ms is not None
            else self._get_header(hdrs, "X-Captured-At")
        )
        if raw_ts is None or str(raw_ts).strip() == "":
            return 422, {"ok": False, "confirmed": False, "error": "Missing required X-Captured-At header"}
        try:
            ts_ms = int(str(raw_ts).strip())
        except ValueError:
            return 422, {"ok": False, "confirmed": False, "error": f"Invalid X-Captured-At header: {raw_ts}"}
        if ts_ms < MIN_VALID_EPOCH_MS or ts_ms > MAX_VALID_EPOCH_MS:
            return 422, {
                "ok": False,
                "confirmed": False,
                "error": f"X-Captured-At timestamp {ts_ms} out of valid campaign bounds",
            }

        raw_slot = slot_key if slot_key is not None else self._get_header(hdrs, "X-Slot-Key")
        slot_ok, slot_dt_wib, slot_err = parse_and_validate_slot_key(raw_slot)
        if not slot_ok:
            return 422, {"ok": False, "confirmed": False, "error": slot_err}
        resolved_slot = str(raw_slot).strip()

        dt_captured_wib = datetime.fromtimestamp(ts_ms / 1000.0, tz=WIB_TIMEZONE)
        expected_slot_from_ts = format_slot_key_from_dt(dt_captured_wib)
        slot_epoch_ms = int(slot_dt_wib.timestamp() * 1000)
        if expected_slot_from_ts != resolved_slot or abs(ts_ms - slot_epoch_ms) >= SLOT_TIMESTAMP_TOLERANCE_MS:
            return 422, {
                "ok": False,
                "confirmed": False,
                "error": (
                    f"X-Slot-Key '{resolved_slot}' is inconsistent with X-Captured-At "
                    f"({dt_captured_wib.strftime('%Y-%m-%d_%H:%M')} WIB)"
                ),
            }

        # 8. Mandatory X-HST-Day Validation (1..42, no silent clamping)
        raw_hst = hst_day if hst_day is not None else self._get_header(hdrs, "X-HST-Day")
        if raw_hst is None or str(raw_hst).strip() == "":
            return 422, {"ok": False, "confirmed": False, "error": "Missing required X-HST-Day header"}
        try:
            resolved_hst = int(str(raw_hst).strip())
        except ValueError:
            return 422, {"ok": False, "confirmed": False, "error": f"Invalid X-HST-Day header: {raw_hst}"}
        if resolved_hst < 1 or resolved_hst > 42:
            return 422, {
                "ok": False,
                "confirmed": False,
                "error": f"X-HST-Day {resolved_hst} out of allowed campaign range (1..42)",
            }

        # 9. Image Format & Pixel Dimension Bounds Validation Prior to CV
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(BytesIO(raw_bytes)) as probe_img:
                    if probe_img.format != "JPEG":
                        return 422, {"ok": False, "confirmed": False, "error": "Decoded image format is not JPEG"}
                    width, height = probe_img.size
                    if (
                        width < MIN_IMAGE_WIDTH
                        or height < MIN_IMAGE_HEIGHT
                        or width > MAX_IMAGE_WIDTH
                        or height > MAX_IMAGE_HEIGHT
                        or (width * height) > MAX_IMAGE_PIXELS
                    ):
                        return 422, {
                            "ok": False,
                            "confirmed": False,
                            "error": (
                                f"Image dimensions {width}x{height} out of allowed bounds "
                                f"({MIN_IMAGE_WIDTH}x{MIN_IMAGE_HEIGHT} .. {MAX_IMAGE_WIDTH}x{MAX_IMAGE_HEIGHT})"
                            ),
                        }
                    pil_img = probe_img.convert("RGB")
        except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            return 422, {
                "ok": False,
                "confirmed": False,
                "error": f"Image dimensions exceed maximum allowed pixel limit ({MAX_IMAGE_PIXELS} px): {exc}",
            }
        except Exception as exc:
            return 422, {"ok": False, "confirmed": False, "error": f"Invalid image encoding: {exc}"}

        # 10. Verify Cloud Storage Readiness
        if not self.rtdb_store.is_configured():
            return 503, {
                "ok": False,
                "confirmed": False,
                "error": "Server storage not configured: missing FIREBASE_RTDB_URL",
            }
        if not self.blob_storage.is_configured():
            return 503, {
                "ok": False,
                "confirmed": False,
                "error": "Server storage not configured: missing BLOB_READ_WRITE_TOKEN",
            }

        # 11. Atomic Slot Deduplication & Fenced Claim in Firebase RTDB
        invocation_owner_id = uuid.uuid4().hex
        try:
            claim_status, slot_state = self.rtdb_store.claim_slot(
                resolved_slot,
                actual_fnv1a,
                owner_id=invocation_owner_id,
                timeout=_remaining_timeout(),
            )
        except Exception as exc:
            return 502, {
                "ok": False,
                "confirmed": False,
                "error": f"Failed to verify/claim slot in Firebase RTDB: {exc}",
            }

        if claim_status == "CONFIRMED":
            existing_fnv = str(slot_state.get("fnv1a") or slot_state.get("checksum_fnv1a") or "").lower()
            checksum_mismatch = bool(existing_fnv and existing_fnv != actual_fnv1a)
            return 200, {
                "ok": True,
                "confirmed": True,
                "duplicate": True,
                "checksum_mismatch": checksum_mismatch,
                "kelompok": "Kelompok 5",
                "slot_key": resolved_slot,
                "image_id": slot_state.get("image_id", ""),
                "file_size": slot_state.get("file_size", actual_size),
                "fnv1a": existing_fnv or actual_fnv1a,
                "checksum_fnv1a": existing_fnv or actual_fnv1a,
                "quality_status": slot_state.get("quality_status", "VALID"),
            }

        if claim_status == "IN_PROGRESS":
            return 409, {
                "ok": False,
                "confirmed": False,
                "error": f"Slot {resolved_slot} is currently being processed by another instance",
            }

        # `slot_state` is our active `lock_record` containing `owner_id` and `fence_token`
        lock_record = slot_state
        safe_slot_id = sanitize_rtdb_key(resolved_slot).replace("-", "")
        deterministic_image_id = f"img_{safe_slot_id}_{actual_fnv1a[:6]}"
        attempt_uploaded_urls = []

        try:
            def _upload_to_blob(img_id, artifacts):
                res_urls = self.blob_storage.upload_cv_artifacts(
                    resolved_slot,
                    img_id,
                    artifacts,
                    timeout_getter=_remaining_timeout,
                )
                attempt_uploaded_urls.extend(res_urls.get("_uploaded_urls", []))
                return res_urls

            record = self.cv_pipeline.process_image(
                input_image=pil_img,
                plant_id=self.plant_id,
                hst_day=resolved_hst,
                timestamp=ts_ms,
                camera_id=self.camera_id,
                image_id_override=deterministic_image_id,
                artifact_uploader=_upload_to_blob,
            )

            record["slot_key"] = resolved_slot
            record["capture_source"] = "esp32cam_wifi_direct"
            record["source_file_name"] = str(file_name or "wifi-camera-upload.jpg")
            record["file_size"] = actual_size
            record["fnv1a"] = actual_fnv1a
            record["checksum_fnv1a"] = actual_fnv1a

            self.rtdb_store.commit_slot_and_metadata(
                resolved_slot,
                lock_record,
                record,
                timeout=_remaining_timeout(),
            )
        except StaleLockOwnerError as exc:
            # Our lock expired and was superseded by a newer owner; NEVER roll back
            # the newer owner's slot state and NEVER delete deterministic blobs!
            return 409, {
                "ok": False,
                "confirmed": False,
                "error": f"Slot lock superseded by a newer invocation: {exc}",
            }
        except Exception as exc:
            partial_urls = getattr(exc, "uploaded_urls", None) or attempt_uploaded_urls
            # Conditionally release the PROCESSING lock ONLY if we still own the fence
            released_by_us = self.rtdb_store.release_failed_slot(
                resolved_slot,
                lock_record,
                str(exc),
            )
            # Clean up partial blobs ONLY if our fenced rollback succeeded (proving no
            # other process took over the slot)
            if released_by_us and partial_urls:
                self.blob_storage.delete_blobs(partial_urls)
            return 502, {
                "ok": False,
                "confirmed": False,
                "error": f"Capture pipeline or storage persistence failed: {exc}",
            }

        return 200, {
            "ok": True,
            "confirmed": True,
            "kelompok": "Kelompok 5",
            "slot_key": resolved_slot,
            "image_id": record["image_id"],
            "file_size": actual_size,
            "fnv1a": actual_fnv1a,
            "checksum_fnv1a": actual_fnv1a,
            "quality_status": record["quality_status"],
            "image_url": record["image_url"],
            "mask_url": record["mask_url"],
            "overlay_url": record["overlay_url"],
        }


# ----------------------------------------------------------------------------
# Vercel Python Serverless Function Entrypoint
# ----------------------------------------------------------------------------
def get_default_ingestor():
    """Creates a fresh ingestor bound to current environment variables."""
    return ServerlessCaptureIngestor()


class handler(BaseHTTPRequestHandler):
    """
    Vercel Python Serverless Function handler for `/api/kelompok5/capture`.
    Strictly stateless per invocation; does NOT use ThreadingHTTPServer.
    """

    ingestor = None

    def _get_ingestor(self):
        return self.ingestor if self.ingestor is not None else get_default_ingestor()

    def _send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(int(status_code))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _reject_method_not_allowed(self):
        self._send_json(
            405,
            {
                "ok": False,
                "confirmed": False,
                "error": "Method Not Allowed. Use POST /api/kelompok5/capture",
            },
        )

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._reject_method_not_allowed()

    def do_PUT(self):
        self._reject_method_not_allowed()

    def do_DELETE(self):
        self._reject_method_not_allowed()

    def do_PATCH(self):
        self._reject_method_not_allowed()

    def do_HEAD(self):
        self._reject_method_not_allowed()

    def do_POST(self):
        clean_path = (self.path or "").split("?", 1)[0]
        if clean_path not in ("/api/kelompok5/capture", "/api/kelompok5/capture/"):
            self._send_json(404, {"ok": False, "confirmed": False, "error": "Not Found"})
            return

        try:
            raw_len = self.headers.get("Content-Length")
            if raw_len is None:
                self._send_json(
                    411,
                    {"ok": False, "confirmed": False, "error": "Missing Content-Length header"},
                )
                return

            try:
                content_length = int(raw_len)
            except ValueError:
                self._send_json(
                    400,
                    {"ok": False, "confirmed": False, "error": "Invalid Content-Length header"},
                )
                return

            if content_length < MIN_PAYLOAD_BYTES:
                self._send_json(
                    422,
                    {"ok": False, "confirmed": False, "error": "Invalid JPEG payload size"},
                )
                return

            if content_length > MAX_PAYLOAD_BYTES:
                self._send_json(
                    413,
                    {
                        "ok": False,
                        "confirmed": False,
                        "error": f"Payload size {content_length} exceeds 4.5MB serverless limit",
                    },
                )
                return

            raw_bytes = self.rfile.read(content_length)
            if len(raw_bytes) != content_length:
                self._send_json(
                    400,
                    {"ok": False, "confirmed": False, "error": "Truncated request body"},
                )
                return

            ingestor = self._get_ingestor()
            status_code, result = ingestor.ingest(
                raw_bytes=raw_bytes,
                headers=self.headers,
                expected_size=self.headers.get("X-File-Size"),
                expected_fnv1a=self.headers.get("X-Checksum-FNV1A"),
                captured_at_ms=self.headers.get("X-Captured-At"),
                slot_key=self.headers.get("X-Slot-Key"),
                hst_day=self.headers.get("X-HST-Day"),
            )
            self._send_json(status_code, result)
        except Exception:
            self._send_json(
                500,
                {"ok": False, "confirmed": False, "error": "Internal server error during capture ingestion"},
            )

    def log_message(self, fmt, *args):
        # Suppress noisy default stderr logging in unit tests while keeping serverless stdout clean
        pass
