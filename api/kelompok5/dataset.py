#!/usr/bin/env python3
"""
==============================================================================
VERCEL PYTHON SERVERLESS FUNCTION: /api/kelompok5/dataset
Project: Monitor Pertumbuhan Selada Keriting (Lactuca sativa L. var. crispa)
Kelompok 5 - CNN Dataset Manager Backend

Responsibilities:
  - GET    /api/kelompok5/dataset : List CNN dataset metadata records from
    Firebase RTDB (`/kelompok5/cnn_dataset`) or local fallback storage.
  - POST   /api/kelompok5/dataset : Upload a dataset image (JPG/JPEG/PNG/WEBP)
    with one of the 4 canonical ground-truth labels:
      * siap_panen        (Siap Panen)
      * mendekati_panen   (Mendekati Panen)
      * masa_pertumbuhan  (Masa Pertumbuhan)
      * bukan_selada      (Bukan Selada)
    Validates authentication (`CAPTURE_SHARED_TOKEN`), magic bytes, file size
    (100 B .. 4.5 MB), image corruption & pixel bounds (64x64 .. 4096x4096),
    and FNV-1a duplicate detection. Runs `LettuceCVPipeline` to extract
    supporting measurement `leaf_width_px`, stores binary images in Vercel Blob
    (or local disk fallback in dev mode) — NEVER Base64 in database — and
    saves metadata + label in Firebase RTDB `/kelompok5/cnn_dataset/<id>`.
    Preserves CNN model inference status as `BELUM_DILATIH` (`cnn_class: None`).
  - PATCH / PUT /api/kelompok5/dataset : Update ground-truth `label` or `notes`
    for an existing dataset record in Firebase RTDB without overwriting other fields.
  - DELETE /api/kelompok5/dataset : Delete a dataset record from Firebase RTDB,
    remove its FNV-1a hash lock, and delete associated binary files from Vercel Blob.
==============================================================================
"""

import os
import re
import sys
import uuid
import hmac
import json
import time
import urllib.request
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler
from datetime import datetime
from io import BytesIO
from PIL import Image

_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_CURRENT_DIR, "..", ".."))
_SCRIPTS_DIR = os.path.join(_REPO_ROOT, "scripts")
for _p in (_REPO_ROOT, _SCRIPTS_DIR, _CURRENT_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from growth_cv_pipeline import LettuceCVPipeline, WIB_TIMEZONE
from cnn_inference_adapter import get_default_cnn_adapter, STATUS_NO_MODEL
from capture import (
    VercelBlobStorage,
    FirebaseRTDBStore,
    compute_fnv1a_hex,
    sanitize_rtdb_key,
    MIN_PAYLOAD_BYTES,
    MAX_PAYLOAD_BYTES,
    FNV1A_HEX_REGEX,
)

MIN_DATASET_IMAGE_DIM = 64
MAX_DATASET_IMAGE_DIM = 4096
Image.MAX_IMAGE_PIXELS = MAX_DATASET_IMAGE_DIM * MAX_DATASET_IMAGE_DIM

VALID_CNN_LABELS = {
    "siap_panen": "Siap Panen",
    "mendekati_panen": "Mendekati Panen",
    "masa_pertumbuhan": "Masa Pertumbuhan",
    "bukan_selada": "Bukan Selada",
}

DATASET_ID_REGEX = re.compile(r"^[a-zA-Z0-9_\-]{4,80}$")


def normalize_cnn_label(raw_label):
    if not raw_label or not isinstance(raw_label, str):
        return None
    clean = raw_label.strip().lower().replace(" ", "_").replace("-", "_")
    return clean if clean in VALID_CNN_LABELS else None


def detect_image_format_and_validate_magic(raw_bytes):
    """
    Validates magic bytes for JPG/JPEG, PNG, and WEBP.
    Rejects Base64 data URIs or any other format.
    Returns `(fmt_ext, content_type, error_msg)`.
    """
    if not isinstance(raw_bytes, (bytes, bytearray)) or len(raw_bytes) < 12:
        return None, None, "File gambar kosong atau terlalu kecil"

    if raw_bytes[:5].lower() == b"data:":
        return None, None, "Penyimpanan gambar Base64 dilarang; kirimkan file biner JPG/PNG/WEBP"

    if raw_bytes[:3] == b"\xff\xd8\xff":
        return "jpg", "image/jpeg", None
    if raw_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return "png", "image/png", None
    if raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"WEBP":
        return "webp", "image/webp", None

    return None, None, "Format file tidak didukung (hanya JPG, JPEG, PNG, atau WEBP)"


def validate_and_decode_image(raw_bytes):
    """
    Verifies magic bytes, checks for image corruption via Pillow verify() + load(),
    and enforces pixel dimension bounds.
    Returns `(pil_rgb_image, width, height, fmt_ext, content_type, error_msg)`.
    """
    fmt_ext, content_type, magic_err = detect_image_format_and_validate_magic(raw_bytes)
    if magic_err:
        return None, 0, 0, None, None, magic_err

    try:
        with Image.open(BytesIO(raw_bytes)) as probe:
            probe.verify()
        with Image.open(BytesIO(raw_bytes)) as img:
            width, height = img.size
            if width < MIN_DATASET_IMAGE_DIM or height < MIN_DATASET_IMAGE_DIM:
                return (
                    None,
                    width,
                    height,
                    fmt_ext,
                    content_type,
                    f"Dimensi gambar ({width}x{height}) terlalu kecil; minimal {MIN_DATASET_IMAGE_DIM}x{MIN_DATASET_IMAGE_DIM} px",
                )
            if width > MAX_DATASET_IMAGE_DIM or height > MAX_DATASET_IMAGE_DIM:
                return (
                    None,
                    width,
                    height,
                    fmt_ext,
                    content_type,
                    f"Dimensi gambar ({width}x{height}) melebihi batas maksimal {MAX_DATASET_IMAGE_DIM}x{MAX_DATASET_IMAGE_DIM} px",
                )
            rgb_img = img.convert("RGB")
            return rgb_img, width, height, fmt_ext, content_type, None
    except Exception as exc:
        return None, 0, 0, fmt_ext, content_type, f"File gambar rusak atau gagal didekode: {exc}"


class CNNDatasetService:
    """
    Manages CNN dataset uploads, duplicate detection, label updates, deletions,
    and train/val/test split preparation backed by Vercel Blob + Firebase RTDB
    (with local file fallback for offline/local development).
    """

    def __init__(
        self,
        rtdb_store=None,
        blob_storage=None,
        shared_token=None,
        local_meta_file=None,
        local_img_dir=None,
        allow_local_fallback=False,
        cnn_adapter=None,
    ):
        self.rtdb_store = rtdb_store if rtdb_store is not None else FirebaseRTDBStore()
        self.blob_storage = blob_storage if blob_storage is not None else VercelBlobStorage()
        self.cnn_adapter = cnn_adapter if cnn_adapter is not None else get_default_cnn_adapter()
        self.shared_token = (
            shared_token
            if shared_token is not None
            else os.environ.get("CAPTURE_SHARED_TOKEN", "").strip()
        )
        self.local_meta_file = local_meta_file or os.path.join(
            _REPO_ROOT, "data", "cnn_dataset_metadata.json"
        )
        self.local_img_dir = local_img_dir or os.path.join(
            _REPO_ROOT, "data", "cnn_dataset_images"
        )
        self.allow_local_fallback = bool(
            allow_local_fallback
            or os.environ.get("ALLOW_LOCAL_DEV_DATASET", "").strip() == "1"
        )

    def _authenticate(self, headers):
        if not self.shared_token:
            if self.allow_local_fallback:
                return True, 200, None
            return (
                False,
                503,
                "Server authentication not configured (missing CAPTURE_SHARED_TOKEN)",
            )

        headers = headers or {}
        candidate = ""
        auth_header = headers.get("Authorization") or headers.get("authorization") or ""
        if auth_header.lower().startswith("bearer "):
            candidate = auth_header[7:].strip()
        if not candidate:
            candidate = (
                headers.get("X-Capture-Token")
                or headers.get("x-capture-token")
                or ""
            ).strip()

        if not candidate:
            return False, 401, "Missing authentication token (Authorization: Bearer <token>)"

        if not hmac.compare_digest(candidate.encode("utf-8"), self.shared_token.encode("utf-8")):
            return False, 403, "Invalid authentication token"

        return True, 200, None

    # ------------------------------------------------------------------
    # Persistence helpers (Firebase RTDB primary, local JSON fallback)
    # ------------------------------------------------------------------
    def _load_local_records(self):
        if not os.path.exists(self.local_meta_file):
            return {}
        try:
            with open(self.local_meta_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
            if isinstance(data, list):
                return {str(r.get("dataset_id") or i): r for i, r in enumerate(data) if isinstance(r, dict)}
        except Exception:
            pass
        return {}

    def _save_local_records(self, records_map):
        os.makedirs(os.path.dirname(self.local_meta_file), exist_ok=True)
        with open(self.local_meta_file, "w", encoding="utf-8") as f:
            json.dump(records_map, f, indent=2)

    def list_records(self):
        """Returns list of all CNN dataset records sorted newest-first."""
        records_map = {}
        if self.rtdb_store.is_configured():
            try:
                _, body, _ = self.rtdb_store._request_json("GET", "cnn_dataset")
                if isinstance(body, dict):
                    records_map.update(body)
            except Exception as exc:
                if not self.allow_local_fallback:
                    return 502, {"ok": False, "error": f"Gagal memuat dataset dari Firebase RTDB: {exc}"}

        if self.allow_local_fallback:
            local_map = self._load_local_records()
            for k, v in local_map.items():
                if k not in records_map:
                    records_map[k] = v

        items = [
            v for v in records_map.values()
            if isinstance(v, dict) and v.get("dataset_id")
        ]
        items.sort(key=lambda r: int(r.get("created_at") or 0), reverse=True)
        model_info = self.cnn_adapter.get_status_dict() if self.cnn_adapter is not None else {}
        return 200, {
            "ok": True,
            "count": len(items),
            "cnn_status": model_info.get("cnn_status", STATUS_NO_MODEL),
            "cnn_model": model_info,
            "records": items,
        }

    def get_model_status(self, force_reload=False):
        """Returns the current external Colab CNN model registration & validation status."""
        if self.cnn_adapter is None:
            return 200, {"ok": True, "cnn_status": STATUS_NO_MODEL, "available": False}
        if force_reload:
            self.cnn_adapter.reload_from_disk()
        st = self.cnn_adapter.get_status_dict()
        return 200, {"ok": True, "cnn_status": st.get("cnn_status", STATUS_NO_MODEL), "model": st}

    def register_model(self, payload, headers):
        """
        Validates and registers a Colab CNN model (from `models/` directory or an
        uploaded metadata/binary bundle). If validation fails, preserves the
        previously active model without interruption.
        """
        authed, code, err = self._authenticate(headers)
        if not authed:
            return code, {"ok": False, "error": err}

        if not isinstance(payload, dict):
            return 400, {"ok": False, "error": "Payload JSON registrasi model tidak valid"}

        action_mode = str(payload.get("mode") or "reload_dir").strip().lower()
        if action_mode == "reload_dir":
            target_dir = payload.get("models_dir") or self.cnn_adapter.models_dir
            res = self.cnn_adapter.register_model_from_directory(target_dir, persist_to_models_dir=False)
        elif action_mode == "bundle":
            files_raw = payload.get("files")
            if not isinstance(files_raw, dict):
                return 422, {"ok": False, "error": "Field 'files' wajib berisi objek file model Colab"}
            bundle_map = {}
            for k, v in files_raw.items():
                if isinstance(v, (dict, list)):
                    bundle_map[k] = json.dumps(v).encode("utf-8")
                elif isinstance(v, str):
                    # Hex-encoded binary support for model_selada_v2.h5 / model.h5 / model.keras / model.tflite
                    if k in ("model_selada_v2.h5", "model.h5", "model.tflite", "model.keras") and v.startswith("hex:"):
                        try:
                            bundle_map[k] = bytes.fromhex(v[4:])
                        except Exception as exc:
                            return 422, {"ok": False, "error": f"Hex biner {k} tidak valid: {exc}"}
                    else:
                        bundle_map[k] = v.encode("utf-8")
                elif isinstance(v, (bytes, bytearray)):
                    bundle_map[k] = bytes(v)
            res = self.cnn_adapter.register_model_bundle(bundle_map, persist_to_models_dir=False)
        else:
            return 422, {"ok": False, "error": f"Mode registrasi model '{action_mode}' tidak dikenal"}

        if not res.get("ok"):
            return 422, {
                "ok": False,
                "error": res.get("error"),
                "stage": res.get("stage"),
                "rolled_back_to_previous": bool(res.get("rolled_back_to_previous")),
                "active_model": res.get("active_model"),
            }

        return 200, {
            "ok": True,
            "cnn_status": res.get("status", STATUS_NO_MODEL),
            "active_model": res.get("active_model"),
        }

    def _find_duplicate_by_fnv1a(self, fnv1a_hex):
        if self.rtdb_store.is_configured():
            try:
                _, hash_entry, _ = self.rtdb_store._request_json(
                    "GET", f"cnn_dataset_hashes/{fnv1a_hex}"
                )
                if isinstance(hash_entry, dict) and hash_entry.get("dataset_id"):
                    return hash_entry.get("dataset_id")
            except Exception:
                pass
        if self.allow_local_fallback:
            for k, v in self._load_local_records().items():
                if isinstance(v, dict) and str(v.get("fnv1a", "")).lower() == fnv1a_hex:
                    return k
        return None

    def upload_image(self, raw_bytes, headers):
        """
        Validates, measures leaf width via CV, stores binary artifacts in Vercel Blob
        (or local disk in dev mode), and saves metadata + ground-truth label in RTDB.
        Never stores Base64 in the database.
        """
        authed, code, err = self._authenticate(headers)
        if not authed:
            return code, {"ok": False, "error": err}

        if not self.rtdb_store.is_configured() and not self.allow_local_fallback:
            return 503, {"ok": False, "error": "Missing FIREBASE_RTDB_URL configuration"}
        if not self.blob_storage.is_configured() and not self.allow_local_fallback:
            return 503, {"ok": False, "error": "Missing BLOB_READ_WRITE_TOKEN configuration"}

        headers = headers or {}
        raw_label = headers.get("X-Dataset-Label") or headers.get("x-dataset-label") or ""
        label_key = normalize_cnn_label(raw_label)
        if not label_key:
            return 422, {
                "ok": False,
                "error": (
                    f"Label kelas CNN tidak valid '{raw_label}'. Pilih salah satu dari: "
                    "siap_panen, mendekati_panen, masa_pertumbuhan, bukan_selada"
                ),
            }

        if not isinstance(raw_bytes, (bytes, bytearray)):
            return 400, {"ok": False, "error": "Body request harus berupa biner gambar"}
        actual_size = len(raw_bytes)
        if actual_size < MIN_PAYLOAD_BYTES:
            return 422, {"ok": False, "error": f"Ukuran file ({actual_size} B) terlalu kecil"}
        if actual_size > MAX_PAYLOAD_BYTES:
            return 413, {"ok": False, "error": f"Ukuran file ({actual_size} B) melebihi batas 4.5 MB"}

        expected_size = headers.get("X-File-Size") or headers.get("x-file-size")
        if expected_size is not None and str(expected_size).strip() != "":
            try:
                if int(expected_size) != actual_size:
                    return 422, {
                        "ok": False,
                        "error": f"Ukuran file tidak cocok: header={expected_size}, aktual={actual_size}",
                    }
            except ValueError:
                return 400, {"ok": False, "error": "Header X-File-Size tidak valid"}

        actual_fnv1a = compute_fnv1a_hex(raw_bytes)
        expected_fnv1a = headers.get("X-Checksum-FNV1A") or headers.get("x-checksum-fnv1a")
        if expected_fnv1a is not None and str(expected_fnv1a).strip() != "":
            clean_hash = str(expected_fnv1a).strip().lower()
            if not FNV1A_HEX_REGEX.match(clean_hash) or clean_hash != actual_fnv1a:
                return 422, {
                    "ok": False,
                    "error": f"Checksum FNV-1a tidak cocok: header={expected_fnv1a}, aktual={actual_fnv1a}",
                }

        # Check duplicate before running CV or uploading blob
        dup_id = self._find_duplicate_by_fnv1a(actual_fnv1a)
        if dup_id:
            return 409, {
                "ok": False,
                "duplicate": True,
                "existing_id": dup_id,
                "fnv1a": actual_fnv1a,
                "error": f"Gambar duplikat terdeteksi (checksum FNV-1a {actual_fnv1a} sudah terdaftar sebagai {dup_id})",
            }

        pil_rgb, width, height, fmt_ext, content_type, img_err = validate_and_decode_image(raw_bytes)
        if img_err:
            return 422, {"ok": False, "error": img_err}

        now_ms = int(time.time() * 1000)
        now_wib = datetime.fromtimestamp(now_ms / 1000.0, tz=WIB_TIMEZONE)
        dataset_id = f"ds_{now_wib.strftime('%Y%m%d_%H%M%S')}_{actual_fnv1a}"

        raw_fname = (headers.get("X-File-Name") or headers.get("x-file-name") or f"{dataset_id}.{fmt_ext}").strip()
        try:
            raw_fname = urllib.parse.unquote(raw_fname)
        except Exception:
            pass
        safe_fname = re.sub(r"[^a-zA-Z0-9._\-]", "_", os.path.basename(raw_fname))[:80] or f"{dataset_id}.{fmt_ext}"

        notes = (headers.get("X-Notes") or headers.get("x-notes") or "").strip()
        try:
            notes = urllib.parse.unquote(notes)
        except Exception:
            pass
        notes = re.sub(r"[<>]", "", notes)[:240]

        raw_hst = headers.get("X-HST-Day") or headers.get("x-hst-day")
        hst_day = None
        if raw_hst is not None and str(raw_hst).strip() != "":
            try:
                h_val = int(raw_hst)
                if 1 <= h_val <= 120:
                    hst_day = h_val
            except ValueError:
                pass

        # Run CV pipeline in /tmp to extract supporting leaf_width_px and generate mask/overlay
        partial_blobs = []
        try:
            pipeline = LettuceCVPipeline(use_tmp_only=True, cnn_adapter=self.cnn_adapter)

            def _upload_artifacts(image_id, artifacts_dict):
                orig_fn = f"{dataset_id}_orig.{fmt_ext}"
                mask_fn = f"{dataset_id}_mask.png"
                overlay_fn = f"{dataset_id}_overlay.jpg"
                _, mask_bytes, _ = artifacts_dict["mask"]
                _, overlay_bytes, _ = artifacts_dict["overlay"]

                if self.blob_storage.is_configured():
                    prefix = f"kelompok5/cnn_dataset/{dataset_id}"
                    u_orig = self.blob_storage.put_bytes(f"{prefix}/{orig_fn}", raw_bytes, content_type)
                    partial_blobs.append(u_orig)
                    u_mask = self.blob_storage.put_bytes(f"{prefix}/{mask_fn}", mask_bytes, "image/png")
                    partial_blobs.append(u_mask)
                    u_over = self.blob_storage.put_bytes(f"{prefix}/{overlay_fn}", overlay_bytes, "image/jpeg")
                    partial_blobs.append(u_over)
                    return {
                        "image_url": u_orig,
                        "mask_url": u_mask,
                        "overlay_url": u_over,
                    }
                else:
                    os.makedirs(self.local_img_dir, exist_ok=True)
                    p_orig = os.path.join(self.local_img_dir, orig_fn)
                    p_mask = os.path.join(self.local_img_dir, mask_fn)
                    p_over = os.path.join(self.local_img_dir, overlay_fn)
                    with open(p_orig, "wb") as f:
                        f.write(raw_bytes)
                    with open(p_mask, "wb") as f:
                        f.write(mask_bytes)
                    with open(p_over, "wb") as f:
                        f.write(overlay_bytes)
                    return {
                        "image_url": f"data/cnn_dataset_images/{orig_fn}",
                        "mask_url": f"data/cnn_dataset_images/{mask_fn}",
                        "overlay_url": f"data/cnn_dataset_images/{overlay_fn}",
                    }

            cv_record = pipeline.process_image(
                pil_rgb,
                plant_id="SLD-DS",
                hst_day=hst_day or 1,
                timestamp=now_ms,
                camera_id="DATASET-UPLOAD",
                image_id_override=dataset_id,
                artifact_uploader=_upload_artifacts,
            )
        except Exception as exc:
            if partial_blobs and self.blob_storage.is_configured():
                self.blob_storage.delete_blobs(partial_blobs)
            return 502, {"ok": False, "error": f"Gagal memproses citra atau mengunggah ke storage: {exc}"}

        leaf_width_px = int(cv_record.get("leaf_width_px") or 0) if label_key != "bukan_selada" else 0
        leaf_area_px = int(cv_record.get("leaf_area_px") or 0) if label_key != "bukan_selada" else 0

        dataset_record = {
            "kelompok": "Kelompok 5",
            "dataset_id": dataset_id,
            "image_id": dataset_id,
            "file_name": safe_fname,
            "file_format": fmt_ext.upper(),
            "content_type": content_type,
            "file_size": actual_size,
            "width_px": width,
            "height_px": height,
            "fnv1a": actual_fnv1a,
            "label": label_key,
            "label_display": VALID_CNN_LABELS[label_key],
            "cnn_class": cv_record.get("cnn_class"),
            "cnn_confidence": cv_record.get("cnn_confidence"),
            "cnn_probabilities": cv_record.get("cnn_probabilities"),
            "cnn_status": cv_record.get("cnn_status", STATUS_NO_MODEL),
            "model_version": cv_record.get("model_version"),
            "model_architecture": cv_record.get("model_architecture"),
            "classified_at": cv_record.get("classified_at"),
            "is_test_model": bool(cv_record.get("is_test_model", False)),
            "leaf_width_px": leaf_width_px,
            "leaf_area_px": leaf_area_px,
            "hst_day": hst_day,
            "quality_status": cv_record.get("quality_status", "VALID"),
            "quality_detail": cv_record.get("quality_detail", ""),
            "notes": notes,
            "source": "dataset_upload",
            "storage_provider": "vercel_blob" if self.blob_storage.is_configured() else "local_disk",
            "image_url": cv_record["image_url"],
            "mask_url": cv_record["mask_url"],
            "overlay_url": cv_record["overlay_url"],
            "created_at": now_ms,
            "updated_at": now_ms,
            "captured_at": now_ms,
            "time_wib": cv_record.get("time_wib", now_wib.strftime("%Y-%m-%d %H:%M:%S WIB")),
        }

        try:
            if self.rtdb_store.is_configured():
                self.rtdb_store._request_json("PUT", f"cnn_dataset/{dataset_id}", payload=dataset_record)
                self.rtdb_store._request_json(
                    "PUT",
                    f"cnn_dataset_hashes/{actual_fnv1a}",
                    payload={"dataset_id": dataset_id, "created_at": now_ms, "label": label_key},
                )
            if self.allow_local_fallback:
                local_map = self._load_local_records()
                local_map[dataset_id] = dataset_record
                self._save_local_records(local_map)
        except Exception as exc:
            if partial_blobs and self.blob_storage.is_configured():
                self.blob_storage.delete_blobs(partial_blobs)
            return 502, {"ok": False, "error": f"Gagal menyimpan metadata dataset ke Firebase RTDB: {exc}"}

        return 200, {
            "ok": True,
            "confirmed": True,
            "record": dataset_record,
        }

    def update_record(self, payload, headers):
        """Updates `label` and/or `notes` on an existing dataset record in RTDB."""
        authed, code, err = self._authenticate(headers)
        if not authed:
            return code, {"ok": False, "error": err}

        if not isinstance(payload, dict):
            return 400, {"ok": False, "error": "Payload JSON tidak valid"}

        dataset_id = str(payload.get("dataset_id") or "").strip()
        if not DATASET_ID_REGEX.match(dataset_id):
            return 422, {"ok": False, "error": "dataset_id tidak valid"}

        label_key = normalize_cnn_label(payload.get("label"))
        if not label_key:
            return 422, {
                "ok": False,
                "error": "Label baru tidak valid. Pilih: siap_panen, mendekati_panen, masa_pertumbuhan, bukan_selada",
            }

        existing = None
        if self.rtdb_store.is_configured():
            try:
                _, existing, _ = self.rtdb_store._request_json("GET", f"cnn_dataset/{dataset_id}")
            except Exception as exc:
                if not self.allow_local_fallback:
                    return 502, {"ok": False, "error": f"Gagal membaca dataset dari Firebase RTDB: {exc}"}

        if not isinstance(existing, dict) and self.allow_local_fallback:
            existing = self._load_local_records().get(dataset_id)

        if not isinstance(existing, dict) or not existing.get("dataset_id"):
            return 404, {"ok": False, "error": f"Data gambar {dataset_id} tidak ditemukan"}

        now_ms = int(time.time() * 1000)
        existing["label"] = label_key
        existing["label_display"] = VALID_CNN_LABELS[label_key]
        existing["updated_at"] = now_ms
        if "notes" in payload and payload["notes"] is not None:
            existing["notes"] = re.sub(r"[<>]", "", str(payload["notes"]).strip())[:240]

        try:
            if self.rtdb_store.is_configured():
                self.rtdb_store._request_json("PUT", f"cnn_dataset/{dataset_id}", payload=existing)
                fnv1a = existing.get("fnv1a")
                if fnv1a:
                    self.rtdb_store._request_json(
                        "PUT",
                        f"cnn_dataset_hashes/{fnv1a}",
                        payload={"dataset_id": dataset_id, "created_at": existing.get("created_at", now_ms), "label": label_key},
                    )
            if self.allow_local_fallback:
                local_map = self._load_local_records()
                local_map[dataset_id] = existing
                self._save_local_records(local_map)
        except Exception as exc:
            return 502, {"ok": False, "error": f"Gagal memperbarui label di Firebase RTDB: {exc}"}

        return 200, {"ok": True, "record": existing}

    def delete_record(self, dataset_id, headers):
        """Deletes dataset record from RTDB, removes hash index, and deletes blobs."""
        authed, code, err = self._authenticate(headers)
        if not authed:
            return code, {"ok": False, "error": err}

        clean_id = str(dataset_id or "").strip()
        if not DATASET_ID_REGEX.match(clean_id):
            return 422, {"ok": False, "error": "dataset_id tidak valid"}

        existing = None
        if self.rtdb_store.is_configured():
            try:
                _, existing, _ = self.rtdb_store._request_json("GET", f"cnn_dataset/{clean_id}")
            except Exception as exc:
                if not self.allow_local_fallback:
                    return 502, {"ok": False, "error": f"Gagal membaca dataset dari Firebase RTDB: {exc}"}

        if not isinstance(existing, dict) and self.allow_local_fallback:
            existing = self._load_local_records().get(clean_id)

        if not isinstance(existing, dict) or not existing.get("dataset_id"):
            return 404, {"ok": False, "error": f"Data gambar {clean_id} tidak ditemukan"}

        blob_urls = [
            existing.get("image_url"),
            existing.get("mask_url"),
            existing.get("overlay_url"),
        ]
        if self.blob_storage.is_configured():
            self.blob_storage.delete_blobs([u for u in blob_urls if u and str(u).startswith("http")])

        if self.allow_local_fallback:
            for u in blob_urls:
                if u and str(u).startswith("data/cnn_dataset_images/"):
                    p = os.path.join(_REPO_ROOT, u)
                    if os.path.exists(p):
                        try:
                            os.remove(p)
                        except Exception:
                            pass

        try:
            if self.rtdb_store.is_configured():
                self.rtdb_store._request_json("DELETE", f"cnn_dataset/{clean_id}")
                fnv1a = existing.get("fnv1a")
                if fnv1a:
                    self.rtdb_store._request_json("DELETE", f"cnn_dataset_hashes/{fnv1a}")
            if self.allow_local_fallback:
                local_map = self._load_local_records()
                local_map.pop(clean_id, None)
                self._save_local_records(local_map)
        except Exception as exc:
            return 502, {"ok": False, "error": f"Gagal menghapus metadata dari Firebase RTDB: {exc}"}

        return 200, {"ok": True, "deleted_id": clean_id}


def get_default_dataset_service():
    return CNNDatasetService()


class handler(BaseHTTPRequestHandler):
    """
    Vercel Python Serverless Function handler for `/api/kelompok5/dataset`.
    """

    service = None

    def _get_service(self):
        return self.service if self.service is not None else get_default_dataset_service()

    def _send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(int(status_code))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body_bytes(self):
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            return None, (411, {"ok": False, "error": "Missing Content-Length header"})
        try:
            content_length = int(raw_len)
        except ValueError:
            return None, (400, {"ok": False, "error": "Invalid Content-Length header"})
        if content_length > MAX_PAYLOAD_BYTES:
            return None, (413, {"ok": False, "error": "Payload exceeds 4.5MB limit"})
        data = self.rfile.read(content_length) if content_length > 0 else b""
        return data, None

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path or "")
        qs = urllib.parse.parse_qs(parsed_url.query)
        action = (qs.get("action") or [""])[0].strip().lower()
        svc = self._get_service()
        if action == "model_status":
            reload_flag = (qs.get("reload") or ["0"])[0] == "1"
            code, res = svc.get_model_status(force_reload=reload_flag)
            self._send_json(code, res)
            return
        code, res = svc.list_records()
        self._send_json(code, res)

    def do_POST(self):
        parsed_url = urllib.parse.urlparse(self.path or "")
        qs = urllib.parse.parse_qs(parsed_url.query)
        action = (qs.get("action") or [""])[0].strip().lower()
        raw_bytes, err = self._read_body_bytes()
        if err:
            self._send_json(err[0], err[1])
            return
        svc = self._get_service()
        if action == "register_model":
            try:
                payload = json.loads(raw_bytes.decode("utf-8")) if raw_bytes else {}
            except Exception:
                self._send_json(400, {"ok": False, "error": "Invalid JSON body"})
                return
            code, res = svc.register_model(payload, self.headers)
            self._send_json(code, res)
            return
        code, res = svc.upload_image(raw_bytes, self.headers)
        self._send_json(code, res)

    def do_PATCH(self):
        raw_bytes, err = self._read_body_bytes()
        if err:
            self._send_json(err[0], err[1])
            return
        try:
            payload = json.loads(raw_bytes.decode("utf-8")) if raw_bytes else {}
        except Exception:
            self._send_json(400, {"ok": False, "error": "Invalid JSON body"})
            return
        svc = self._get_service()
        if isinstance(payload, dict) and payload.get("action") == "register_model":
            code, res = svc.register_model(payload, self.headers)
            self._send_json(code, res)
            return
        code, res = svc.update_record(payload, self.headers)
        self._send_json(code, res)

    def do_PUT(self):
        self.do_PATCH()

    def do_DELETE(self):
        parsed_url = urllib.parse.urlparse(self.path or "")
        qs = urllib.parse.parse_qs(parsed_url.query)
        dataset_id = (qs.get("dataset_id") or [None])[0]
        if not dataset_id:
            raw_bytes, _ = self._read_body_bytes()
            if raw_bytes:
                try:
                    body = json.loads(raw_bytes.decode("utf-8"))
                    dataset_id = body.get("dataset_id")
                except Exception:
                    pass
        svc = self._get_service()
        code, res = svc.delete_record(dataset_id, self.headers)
        self._send_json(code, res)
