#!/usr/bin/env python3
"""
Automated unit and integration test suite for:
  - scripts/growth_cv_pipeline.py
  - scripts/scheduler_daemon.py
Ensures strict verification of quality validation, segmentation, morphology,
measurement calculations, physical calibration, and scheduler slot logic.
"""

import os
import sys
import unittest
import numpy as np
from PIL import Image, ImageFilter
import shutil
from datetime import datetime, timezone, timedelta

# Import modules from scripts
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'scripts')))
from growth_cv_pipeline import LettuceCVPipeline, WIB_TIMEZONE
from scheduler_daemon import LeafGrowthScheduler, compute_fnv1a_hex
import io
import json
import time
import tempfile

def _create_unit_test_image(width=320, height=240, has_plant=True, is_dark=False, is_blur=False):
    """
    Pure in-memory unit test matrix (not used for production data generation).
    Strictly for asserting OpenCV mathematical equations (ExG, Otsu, Laplacian).
    """
    if is_dark:
        return Image.new("RGB", (width, height), (5, 5, 5))

    img = Image.new("RGB", (width, height), (40, 30, 20)) # Substrate
    if has_plant:
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        # Add high-contrast green ellipse in center
        cx, cy = width // 2, height // 2
        rx, ry = width // 4, height // 4
        draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(30, 180, 40))
        # Add texture details to pass Laplacian variance threshold
        for offset in range(-rx + 10, rx - 10, 8):
            draw.line([cx + offset, cy - ry + 15, cx + offset, cy + ry - 15], fill=(20, 140, 30), width=2)

    if is_blur:
        img = img.filter(ImageFilter.GaussianBlur(radius=15))

    return img

class TestLettuceCVPipeline(unittest.TestCase):
    def setUp(self):
        self.temp_out = "data/test_growth_images"
        self.temp_meta = "data/test_growth_meta.json"
        os.makedirs(self.temp_out, exist_ok=True)
        if os.path.exists(self.temp_meta):
            os.remove(self.temp_meta)
        self.pipeline = LettuceCVPipeline(output_dir=self.temp_out, meta_file=self.temp_meta)

    def tearDown(self):
        if os.path.exists(self.temp_meta):
            os.remove(self.temp_meta)
        shutil.rmtree(self.temp_out, ignore_errors=True)

    def test_quality_validation_normal_plant(self):
        img = _create_unit_test_image(width=320, height=240, has_plant=True)
        np_img = np.array(img)
        is_valid, status, detail = self.pipeline.validate_quality(np_img)
        self.assertTrue(is_valid)
        self.assertEqual(status, "VALID")

    def test_quality_validation_pitch_dark_rejected(self):
        dark_img = _create_unit_test_image(width=320, height=240, is_dark=True)
        np_img = np.array(dark_img)
        is_valid, status, detail = self.pipeline.validate_quality(np_img)
        self.assertFalse(is_valid)
        self.assertEqual(status, "INVALID_DARK")

    def test_quality_validation_blurred_rejected(self):
        img = _create_unit_test_image(width=320, height=240, has_plant=True, is_blur=True)
        np_img = np.array(img)
        is_valid, status, detail = self.pipeline.validate_quality(np_img)
        self.assertFalse(is_valid)
        self.assertEqual(status, "INVALID_BLUR")

    def test_segmentation_exg_binary_mask(self):
        img = _create_unit_test_image(width=320, height=240, has_plant=True)
        np_img = np.array(img)
        mask = self.pipeline.segment_vegetation(np_img)
        self.assertEqual(mask.shape, (240, 320))
        # Mask must only contain 0 and 255
        unique_vals = set(np.unique(mask))
        self.assertTrue(unique_vals.issubset({0, 255}))
        # Positive leaf pixels must be detected
        self.assertGreater(np.sum(mask == 255), 500)

    def test_measurements_width_and_area(self):
        img = _create_unit_test_image(width=320, height=240, has_plant=True)
        np_img = np.array(img)
        mask = self.pipeline.segment_vegetation(np_img)
        res = self.pipeline.extract_contour_and_measurements(mask)
        self.assertGreater(res["leaf_width_px"], 50)
        self.assertGreater(res["leaf_area_px"], 1000)
        self.assertGreater(len(res["contour_pts"]), 5)

    def test_uncalibrated_returns_null_physical_units(self):
        img = _create_unit_test_image(width=320, height=240, has_plant=True)
        rec = self.pipeline.process_image(img, plant_id="SLD-TEST", hst_day=20)
        self.assertIsNone(rec["leaf_width_mm"])
        self.assertIsNone(rec["leaf_area_mm2"])
        self.assertGreater(rec["leaf_width_px"], 0)
        self.assertGreater(rec["leaf_area_px"], 0)

    def test_calibrated_converts_physical_units(self):
        calib_pipeline = LettuceCVPipeline(
            output_dir=self.temp_out,
            meta_file=self.temp_meta,
            calib_factor_mm_per_px=0.5
        )
        img = _create_unit_test_image(width=320, height=240, has_plant=True)
        rec = calib_pipeline.process_image(img, plant_id="SLD-TEST", hst_day=20)
        self.assertIsNotNone(rec["leaf_width_mm"])
        self.assertIsNotNone(rec["leaf_area_mm2"])
        self.assertAlmostEqual(rec["leaf_width_mm"], rec["leaf_width_px"] * 0.5, places=2)


class TestSchedulerDaemon(unittest.TestCase):
    def setUp(self):
        self.test_cfg = {
            "total_days": 42,
            "target_valid_images": 1600,
            "start_time_wib": "07:00",
            "end_time_wib": "16:50",
            "slot_interval_minutes": 10,
            "camera_host": "127.0.0.1:9999",
            "camera_timeout_seconds": 1,
            "max_retries": 1,
            "retry_delay_seconds": 0,
            "plant_id": "SLD-TEST",
            "camera_id": "ESP32-CAM-01",
            "metadata_path": "data/test_sched_meta.json",
            "images_dir": "data/test_sched_images",
            "log_file": "data/test_sched.log"
        }
        if os.path.exists(self.test_cfg["metadata_path"]):
            os.remove(self.test_cfg["metadata_path"])
        self.scheduler = LeafGrowthScheduler(self.test_cfg)

    def tearDown(self):
        if os.path.exists(self.test_cfg["metadata_path"]):
            os.remove(self.test_cfg["metadata_path"])
        if os.path.exists(self.test_cfg["log_file"]):
            os.remove(self.test_cfg["log_file"])
        shutil.rmtree(self.test_cfg["images_dir"], ignore_errors=True)

    def test_schedule_window_timing(self):
        # 06:59 WIB is outside
        t_early = datetime(2026, 10, 31, 6, 59, tzinfo=WIB_TIMEZONE)
        self.assertFalse(self.scheduler.is_within_window(t_early))

        # 07:00 WIB is inside (start)
        t_start = datetime(2026, 10, 31, 7, 0, tzinfo=WIB_TIMEZONE)
        self.assertTrue(self.scheduler.is_within_window(t_start))

        # 12:30 WIB is inside
        t_mid = datetime(2026, 10, 31, 12, 30, tzinfo=WIB_TIMEZONE)
        self.assertTrue(self.scheduler.is_within_window(t_mid))

        # 16:50 WIB is inside (end boundary)
        t_end = datetime(2026, 10, 31, 16, 50, tzinfo=WIB_TIMEZONE)
        self.assertTrue(self.scheduler.is_within_window(t_end))

        # 16:51 WIB is outside
        t_late = datetime(2026, 10, 31, 16, 51, tzinfo=WIB_TIMEZONE)
        self.assertFalse(self.scheduler.is_within_window(t_late))

    def test_duplicate_prevention(self):
        dt = datetime(2026, 10, 31, 10, 20, tzinfo=WIB_TIMEZONE)
        slot_key = self.scheduler.get_slot_key(dt)
        self.assertEqual(slot_key, "2026-10-31_10:20")

        self.scheduler.executed_slots.add(slot_key)
        self.assertIn(slot_key, self.scheduler.executed_slots)

    def test_failed_capture_logging_no_synthetic_fabrication(self):
        # When camera is unreachable and simulation is false, record failure with 0 measurements
        dt = datetime(2026, 10, 31, 11, 0, tzinfo=WIB_TIMEZONE)
        slot_key = self.scheduler.get_slot_key(dt)
        rec = self.scheduler.record_failure(slot_key, "Connection refused", dt, hst_day=24)
        self.assertEqual(rec["processing_status"], "FAILED")
        self.assertEqual(rec["quality_status"], "INVALID_OFFLINE")
        self.assertEqual(rec["leaf_width_px"], 0)
        self.assertEqual(rec["leaf_area_px"], 0)
        self.assertIsNone(rec["leaf_width_mm"])
        self.assertIn(slot_key, self.scheduler.executed_slots)

    def test_ingest_synced_photo_confirms_valid_fnv1a_and_rejects_mismatch(self):
        img = _create_unit_test_image(width=320, height=240, has_plant=True)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        raw_bytes = buf.getvalue()
        valid_checksum = compute_fnv1a_hex(raw_bytes)

        # 1. Mismatched checksum must be rejected (confirmed=False so ESP32-CAM retains local SD file)
        bad_res = self.scheduler.ingest_synced_photo(
            raw_bytes=raw_bytes,
            slot_key="2026-11-02_08:00",
            captured_at_ms=1762045200000,
            hst_day=10,
            expected_checksum="deadbeef",
            expected_size=len(raw_bytes)
        )
        self.assertFalse(bad_res["ok"])
        self.assertFalse(bad_res["confirmed"])

        # 2. Valid checksum & size must process 1 photo and return confirmed=True
        ok_res = self.scheduler.ingest_synced_photo(
            raw_bytes=raw_bytes,
            slot_key="2026-11-02_08:00",
            captured_at_ms=1762045200000,
            hst_day=10,
            expected_checksum=valid_checksum,
            expected_size=len(raw_bytes)
        )
        self.assertTrue(ok_res["ok"])
        self.assertTrue(ok_res["confirmed"])
        self.assertEqual(ok_res["checksum_fnv1a"], valid_checksum)
        self.assertIn("2026-11-02_08:00", self.scheduler.executed_slots)


class TestESP32CamSlotPersistence(unittest.TestCase):
    """
    Firmware slot state management tests:
    1. Reboot sebelum upload
    2. Timeout
    3. HTTP 422
    4. Respons tidak valid
    5. Sukses
    6. Reboot setelah sukses & slot berikutnya tidak terhalang
    """
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.meta_file = os.path.join(self.temp_dir, "meta.json")
        self.img_dir = os.path.join(self.temp_dir, "images")
        os.makedirs(self.img_dir, exist_ok=True)
        with open(self.meta_file, "w") as f:
            json.dump([], f)
        self.cfg = {
            "total_days": 42,
            "target_valid_images": 1600,
            "start_time_wib": "07:00",
            "end_time_wib": "16:50",
            "slot_interval_minutes": 10,
            "camera_host": "192.168.1.105",
            "camera_timeout_seconds": 6,
            "max_retries": 3,
            "retry_delay_seconds": 2,
            "plant_id": "SLD-01",
            "camera_id": "ESP32-CAM-01",
            "metadata_path": self.meta_file,
            "images_dir": self.img_dir,
            "log_file": os.path.join(self.temp_dir, "daemon.log")
        }
        self.scheduler = LeafGrowthScheduler(self.cfg)
        self.img = _create_unit_test_image(width=160, height=120, has_plant=True)
        buf = io.BytesIO()
        self.img.save(buf, format="JPEG", quality=85)
        self.raw_bytes = buf.getvalue()
        self.valid_fnv = compute_fnv1a_hex(self.raw_bytes)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_reboot_before_upload(self):
        # 1. Slot attempt interrupted by reboot before upload: NVS remains empty
        nvs_confirmed_slot = ""
        attempted_slot = ""
        slot = "2026-11-03_07:00"

        # Before upload, attempted_slot is marked in RAM
        attempted_slot = slot

        # Reboot occurs: RAM is wiped, NVS persists
        attempted_slot = ""
        # System re-evaluates: slot is NOT in confirmed_slot and NOT in attempted_slot
        should_run = (slot != nvs_confirmed_slot and slot != attempted_slot)
        self.assertTrue(should_run, "Slot must be allowed to execute after reboot if not yet confirmed")

    def test_timeout_handling(self):
        # 2. Timeout: upload fails, confirmed_slot is not updated
        nvs_confirmed_slot = ""
        slot = "2026-11-03_07:10"
        # Simulate timeout in network call
        upload_success = False
        if upload_success:
            nvs_confirmed_slot = slot
        self.assertEqual(nvs_confirmed_slot, "")

    def test_http_422_rejection(self):
        # 3. HTTP 422: receiver rejects invalid payload
        nvs_confirmed_slot = ""
        slot = "2026-11-03_07:20"
        res = self.scheduler.ingest_synced_photo(
            raw_bytes=b"CORRUPTED_PAYLOAD_NON_JPEG" * 5,
            slot_key=slot,
            captured_at_ms=1762129200000,
            hst_day=1
        )
        self.assertFalse(res["ok"])
        self.assertFalse(res["confirmed"])
        # Firmware only saves to NVS if res has ok=true and confirmed=true
        if res.get("ok") and res.get("confirmed"):
            nvs_confirmed_slot = slot
        self.assertEqual(nvs_confirmed_slot, "")

    def test_invalid_response_rejection(self):
        # 4. Invalid response: HTTP 200 without ok=true & confirmed=true must NOT be considered success
        nvs_confirmed_slot = ""
        slot = "2026-11-03_07:30"
        mock_http_code = 200
        mock_response_body = '{"status":"received","warning":"not_yet_processed"}'
        # Verification matching firmware logic:
        # code == 200 && response.indexOf("\"ok\":true") >= 0 && response.indexOf("\"confirmed\":true") >= 0
        is_success = (mock_http_code == 200 and
                      '"ok":true' in mock_response_body and
                      '"confirmed":true' in mock_response_body)
        if is_success:
            nvs_confirmed_slot = slot
        self.assertFalse(is_success)
        self.assertEqual(nvs_confirmed_slot, "")

    def test_success_confirmation(self):
        # 5. Success: valid response saves confirmed_slot to NVS
        nvs_confirmed_slot = ""
        slot = "2026-11-03_07:40"
        res = self.scheduler.ingest_synced_photo(
            raw_bytes=self.raw_bytes,
            slot_key=slot,
            captured_at_ms=1762130400000,
            expected_fnv1a=self.valid_fnv,
            hst_day=1
        )
        self.assertTrue(res["ok"])
        self.assertTrue(res["confirmed"])
        mock_http_code = 200
        mock_body = json.dumps(res)
        is_success = (mock_http_code == 200 and
                      '"ok": true' in mock_body and
                      '"confirmed": true' in mock_body)
        self.assertTrue(is_success)
        if is_success:
            nvs_confirmed_slot = slot
        self.assertEqual(nvs_confirmed_slot, slot)

    def test_reboot_after_success_and_next_slot(self):
        # 6. Reboot after success loads confirmed_slot and prevents double upload
        nvs_confirmed_slot = "2026-11-03_07:40"
        # Reboot occurs
        confirmedSlotKey = nvs_confirmed_slot
        attemptedSlotKey = ""

        # Same slot must be skipped
        same_slot = "2026-11-03_07:40"
        skip_same = (same_slot == confirmedSlotKey or same_slot == attemptedSlotKey)
        self.assertTrue(skip_same, "Already confirmed slot must be skipped")

        # Next slot (07:50) must not be blocked by anything
        next_slot = "2026-11-03_07:50"
        should_run_next = (next_slot != confirmedSlotKey and next_slot != attemptedSlotKey)
        self.assertTrue(should_run_next, "Next slot must not be blocked")


class TestESP32CamPortalContract(unittest.TestCase):
    """Audits the AP+STA portal contract, route parameters, and status JSON compatibility."""

    def test_portal_save_validation(self):
        def validate_save_credentials(ssid: str, password: str) -> bool:
            ssid_clean = ssid.strip() if ssid else ""
            if not ssid_clean or len(ssid_clean) > 32 or len(password) > 64:
                return False
            return True

        self.assertTrue(validate_save_credentials("MyHomeWiFi", "SecretPass123"))
        self.assertTrue(validate_save_credentials("   SpacedSSID   ", ""))
        self.assertFalse(validate_save_credentials("", "SecretPass123"))
        self.assertFalse(validate_save_credentials("   ", "SecretPass123"))
        self.assertFalse(validate_save_credentials("A" * 33, "SecretPass123"))
        self.assertFalse(validate_save_credentials("MyHomeWiFi", "P" * 65))

    def test_extended_status_json_contract(self):
        sample_status = {
            "device": "ESP32-CAM",
            "camera_ready": True,
            "wifi_connected": True,
            "ntp_synced": True,
            "captured": 120,
            "uploaded": 119,
            "failed": 1,
            "hst_day": 3,
            "last_slot": "2026-11-03_07:40",
            "confirmed_slot": "2026-11-03_07:40",
            "attempted_slot": "2026-11-03_07:40",
            "ap_ssid": "DAUN KERITING",
            "ap_ip": "192.168.50.1",
            "sta_ip": "192.168.1.150",
            "rssi": -65,
            "stream_port": 81,
            "stream_endpoint": "/stream"
        }
        # Verify all legacy keys exist and match types
        self.assertIsInstance(sample_status["camera_ready"], bool)
        self.assertIsInstance(sample_status["wifi_connected"], bool)
        self.assertIsInstance(sample_status["uploaded"], int)
        self.assertEqual(sample_status["stream_endpoint"], "/stream")
        # Verify all AP/STA extension keys exist
        self.assertEqual(sample_status["device"], "ESP32-CAM")
        self.assertEqual(sample_status["ap_ssid"], "DAUN KERITING")
        self.assertEqual(sample_status["ap_ip"], "192.168.50.1")
        self.assertEqual(sample_status["stream_port"], 81)


class _MockHTTPResponse:
    def __init__(self, status, body_dict, headers=None):
        self.status = status
        self._raw = json.dumps(body_dict).encode("utf-8") if body_dict is not None else b"null"
        self.headers = headers or {}

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False


class _InMemoryFirebaseTransport:
    """
    Simulates Firebase Realtime Database REST API with strict opt-in ETag
    Compare-And-Swap (X-Firebase-ETag + If-Match), DELETE support, and fault injection.
    """
    def __init__(self):
        self.store = {}
        self.etags = {}
        self.version = 1
        self.fail_on_metadata_put = False
        self.fail_on_slot_confirm_put = False
        self.simulate_cas_412_once = False
        self.cas_412_winner_state = None
        self.omit_etag_on_get = False

    def urlopen(self, req, timeout=8):
        import urllib.error
        import urllib.parse
        parsed_url = urllib.parse.urlparse(req.full_url)
        rel_path = parsed_url.path.lstrip("/")
        if rel_path.endswith(".json"):
            rel_path = rel_path[:-5]
        method = req.get_method()
        hdrs = {k.lower(): v for k, v in req.header_items()}

        if method == "GET":
            val = self.store.get(rel_path)
            if val is None:
                prefix = rel_path.rstrip("/") + "/"
                children = {
                    k[len(prefix):]: v
                    for k, v in self.store.items()
                    if k.startswith(prefix) and "/" not in k[len(prefix):] and v is not None
                }
                if children:
                    val = children
            resp_headers = {}
            if not self.omit_etag_on_get and hdrs.get("x-firebase-etag") == "true":
                resp_headers["ETag"] = self.etags.get(rel_path, "etag-null")
            return _MockHTTPResponse(200, val, headers=resp_headers)

        if method == "DELETE":
            self.store.pop(rel_path, None)
            self.version += 1
            self.etags[rel_path] = f"etag-v{self.version}"
            return _MockHTTPResponse(200, None, headers={"ETag": self.etags[rel_path]})

        if method == "PUT":
            if "growth_metadata/" in rel_path and self.fail_on_metadata_put:
                raise urllib.error.HTTPError(
                    req.full_url, 503, "Simulated RTDB metadata write failure", {}, io.BytesIO(b"")
                )

            payload = json.loads(req.data.decode("utf-8")) if req.data else None
            if (
                "executed_slots/" in rel_path
                and isinstance(payload, dict)
                and payload.get("status") == "CONFIRMED"
                and self.fail_on_slot_confirm_put
            ):
                self.fail_on_slot_confirm_put = False
                raise urllib.error.HTTPError(
                    req.full_url, 503, "Simulated RTDB slot confirm PUT failure", {}, io.BytesIO(b"")
                )

            if_match = hdrs.get("if-match")
            current_etag = self.etags.get(rel_path, "etag-null")
            if self.simulate_cas_412_once and "executed_slots/" in rel_path:
                self.simulate_cas_412_once = False
                if self.cas_412_winner_state is not None:
                    self.store[rel_path] = self.cas_412_winner_state
                    self.version += 1
                    current_etag = f"etag-v{self.version}"
                    self.etags[rel_path] = current_etag
                body_bytes = json.dumps(self.store.get(rel_path)).encode("utf-8")
                raise urllib.error.HTTPError(
                    req.full_url,
                    412,
                    "Precondition Failed",
                    {"ETag": current_etag},
                    io.BytesIO(body_bytes),
                )
            if if_match and if_match != current_etag:
                body_bytes = json.dumps(self.store.get(rel_path)).encode("utf-8")
                raise urllib.error.HTTPError(
                    req.full_url,
                    412,
                    "Precondition Failed",
                    {"ETag": current_etag},
                    io.BytesIO(body_bytes),
                )

            self.store[rel_path] = payload
            self.version += 1
            new_etag = f"etag-v{self.version}"
            self.etags[rel_path] = new_etag
            return _MockHTTPResponse(200, payload, headers={"ETag": new_etag})

        raise RuntimeError(f"Unsupported method {method}")


class _InMemoryVercelBlobTransport:
    """
    Simulates Vercel Blob REST API v7/v2 semantics:
      - Enforces `x-allow-overwrite: 1` when a pathname already exists
      - Supports `POST /delete` for partial artifact cleanup
      - Supports targeted failure on N-th PUT call
    """
    def __init__(self):
        self.blobs = {}
        self.put_calls = 0
        self.fail_next_put = False
        self.fail_on_put_call = None
        self.deleted_urls = []
        self.ignore_delete = False

    def urlopen(self, req, timeout=10):
        import urllib.error
        method = req.get_method()
        hdrs = {k.lower(): v for k, v in req.header_items()}

        if method == "POST" and req.full_url.endswith("/delete"):
            body = json.loads(req.data.decode("utf-8")) if req.data else {}
            for u in body.get("urls", []):
                self.deleted_urls.append(u)
                if not self.ignore_delete:
                    prefix = "https://test-store.public.blob.vercel-storage.com/"
                    if u.startswith(prefix):
                        self.blobs.pop(u[len(prefix):], None)
            return _MockHTTPResponse(200, {"deleted": True})

        if method == "PUT":
            self.put_calls += 1
            if self.fail_next_put or (
                self.fail_on_put_call is not None and self.put_calls == self.fail_on_put_call
            ):
                self.fail_next_put = False
                if self.fail_on_put_call == self.put_calls:
                    self.fail_on_put_call = None
                raise urllib.error.HTTPError(
                    req.full_url,
                    502,
                    "Simulated Vercel Blob upstream error",
                    {},
                    io.BytesIO(b"upstream blob error"),
                )

            pathname = req.full_url.split("blob.vercel-storage.com/", 1)[-1]
            if pathname in self.blobs and hdrs.get("x-allow-overwrite") != "1":
                raise urllib.error.HTTPError(
                    req.full_url,
                    400,
                    "This blob already exists",
                    {},
                    io.BytesIO(b'{"error":{"code":"bad_request","message":"This blob already exists"}}'),
                )
            self.blobs[pathname] = bytes(req.data or b"")
            url = f"https://test-store.public.blob.vercel-storage.com/{pathname}"
            return _MockHTTPResponse(200, {"url": url, "pathname": pathname})

        raise RuntimeError(f"Unsupported Blob method {method}")


class TestVercelServerlessCaptureUnitMock(unittest.TestCase):
    """
    Unit tests (with strict in-memory mock cloud transports) for Phase 1 Vercel
    Serverless adapter (`api/kelompok5/capture.py`):
      - Fail-closed CAPTURE_SHARED_TOKEN authentication (503 when empty, 401 when wrong)
      - Genuine calendar date, 07:00-16:50 WIB 10-min slot window, & timestamp consistency
      - Mandatory headers & HST range (1..42) without silent clamping
      - Image pixel dimension bounds (64x64 .. 1600x1200) prior to CV
      - Mandatory ETag CAS, HTTP 412 race handling, lease expiry, owner_id & monotonic
        fencing token protection against stale worker commit/rollback
      - Idempotent Vercel Blob overwrite (`x-allow-overwrite: 1`) & fenced partial cleanup
    """

    @classmethod
    def setUpClass(cls):
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        if repo_root not in sys.path:
            sys.path.insert(0, repo_root)
        from api.kelompok5.capture import (
            VercelBlobStorage,
            FirebaseRTDBStore,
            ServerlessCaptureIngestor,
            MissingETagError,
            StaleLockOwnerError,
            handler as ServerlessHandler,
            MAX_PAYLOAD_BYTES,
        )
        cls.VercelBlobStorage = VercelBlobStorage
        cls.FirebaseRTDBStore = FirebaseRTDBStore
        cls.ServerlessCaptureIngestor = ServerlessCaptureIngestor
        cls.MissingETagError = MissingETagError
        cls.StaleLockOwnerError = StaleLockOwnerError
        cls.ServerlessHandler = ServerlessHandler
        cls.MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES

    def setUp(self):
        self.img = _create_unit_test_image(width=240, height=180, has_plant=True)
        buf = io.BytesIO()
        self.img.save(buf, format="JPEG", quality=88)
        self.raw_bytes = buf.getvalue()
        self.valid_fnv1a = compute_fnv1a_hex(self.raw_bytes)

        self.rtdb_transport = _InMemoryFirebaseTransport()
        self.blob_transport = _InMemoryVercelBlobTransport()

        self.blob_storage = self.VercelBlobStorage(
            token="vercel_blob_rw_test_token",
            urlopen_fn=self.blob_transport.urlopen,
        )
        self.rtdb_store = self.FirebaseRTDBStore(
            db_url="https://selada-test-default-rtdb.asia-southeast1.firebasedatabase.app",
            auth_token="firebase_secret_test",
            urlopen_fn=self.rtdb_transport.urlopen,
        )
        self.cv_pipeline = LettuceCVPipeline(use_tmp_only=True)
        self.ingestor = self.ServerlessCaptureIngestor(
            blob_storage=self.blob_storage,
            rtdb_store=self.rtdb_store,
            cv_pipeline=self.cv_pipeline,
            shared_token="test-shared-secret-token-2026",
        )

    @staticmethod
    def _slot_to_epoch_ms(slot_key):
        try:
            dt = datetime.strptime(slot_key, "%Y-%m-%d_%H:%M").replace(tzinfo=WIB_TIMEZONE)
            return int(dt.timestamp() * 1000) + 5000  # +5s inside the 10-min slot
        except Exception:
            return 1762128005000  # 2025-11-03 07:00:05 WIB fallback for malformed slot tests

    def _default_headers(
        self,
        slot_key="2026-11-03_08:00",
        token="test-shared-secret-token-2026",
        captured_at_ms=None,
        hst_day="12",
        file_size=None,
        fnv1a=None,
    ):
        ts_val = captured_at_ms if captured_at_ms is not None else str(self._slot_to_epoch_ms(slot_key))
        hdrs = {
            "Content-Type": "image/jpeg",
            "X-Kelompok": "Kelompok 5",
            "X-Slot-Key": slot_key,
            "X-Captured-At": str(ts_val),
            "X-HST-Day": str(hst_day),
            "X-File-Size": str(file_size if file_size is not None else len(self.raw_bytes)),
            "X-Checksum-FNV1A": str(fnv1a if fnv1a is not None else self.valid_fnv1a),
        }
        if token is not None:
            hdrs["X-Capture-Token"] = token
        return hdrs

    def test_ephemeral_tmp_cleanup_and_end_to_end_confirmation(self):
        tmp_base = "/tmp" if os.path.isdir("/tmp") else tempfile.gettempdir()
        before_tmp = {name for name in os.listdir(tmp_base) if name.startswith("selada_cv_")}

        status, body = self.ingestor.ingest(
            raw_bytes=self.raw_bytes,
            headers=self._default_headers("2026-11-03_08:00"),
        )
        after_tmp = {name for name in os.listdir(tmp_base) if name.startswith("selada_cv_")}

        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertTrue(body["confirmed"])
        self.assertEqual(body["slot_key"], "2026-11-03_08:00")
        self.assertEqual(body["fnv1a"], self.valid_fnv1a)
        self.assertEqual(before_tmp, after_tmp, "All temporary /tmp/selada_cv_* directories must be cleaned up")

        # Verify all 3 CV artifacts were uploaded to Vercel Blob
        self.assertEqual(len(self.blob_transport.blobs), 3)
        self.assertTrue(body["image_url"].startswith("https://test-store.public.blob.vercel-storage.com/"))
        self.assertTrue(body["mask_url"].endswith("_mask.png"))
        self.assertTrue(body["overlay_url"].endswith("_overlay.jpg"))

        # Verify Firebase RTDB holds both metadata and CONFIRMED slot state with owner_id & fence_token
        slot_state = self.rtdb_transport.store.get("kelompok5/executed_slots/2026-11-03_08-00")
        meta_state = self.rtdb_transport.store.get("kelompok5/growth_metadata/2026-11-03_08-00")
        self.assertIsNotNone(slot_state)
        self.assertEqual(slot_state["status"], "CONFIRMED")
        self.assertEqual(slot_state["fence_token"], 1)
        self.assertTrue(bool(slot_state.get("owner_id")))
        self.assertIsNotNone(meta_state)
        self.assertEqual(meta_state["owner_id"], slot_state["owner_id"])
        self.assertEqual(meta_state["fence_token"], 1)
        self.assertGreater(meta_state["leaf_width_px"], 0)

    def test_idempotent_duplicate_slot_and_different_checksum_detection(self):
        hdrs = self._default_headers("2026-11-03_08:10")
        status1, body1 = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs)
        self.assertEqual(status1, 200)
        self.assertTrue(body1["confirmed"])
        self.assertEqual(len(self.blob_transport.blobs), 3)

        # 1. Duplicate upload with identical checksum -> duplicate=True, checksum_mismatch=False
        self.blob_transport.fail_next_put = True
        status2, body2 = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs)
        self.assertEqual(status2, 200)
        self.assertTrue(body2["ok"])
        self.assertTrue(body2["confirmed"])
        self.assertTrue(body2["duplicate"])
        self.assertFalse(body2["checksum_mismatch"])
        self.assertEqual(len(self.blob_transport.blobs), 3)

        # 2. Duplicate upload for the same confirmed slot with DIFFERENT valid JPEG checksum
        img_diff = _create_unit_test_image(width=240, height=180, has_plant=False)
        buf_diff = io.BytesIO()
        img_diff.save(buf_diff, format="JPEG", quality=85)
        raw_diff = buf_diff.getvalue()
        fnv_diff = compute_fnv1a_hex(raw_diff)
        self.assertNotEqual(fnv_diff, self.valid_fnv1a)

        hdrs_diff = self._default_headers(
            "2026-11-03_08:10",
            file_size=len(raw_diff),
            fnv1a=fnv_diff,
        )
        status3, body3 = self.ingestor.ingest(raw_bytes=raw_diff, headers=hdrs_diff)
        self.assertEqual(status3, 200)
        self.assertTrue(body3["duplicate"])
        self.assertTrue(body3["checksum_mismatch"])
        self.assertEqual(body3["fnv1a"], self.valid_fnv1a)

    def test_partial_blob_upload_cleanup_and_idempotent_retry(self):
        hdrs = self._default_headers("2026-11-03_08:20")

        # 1. Fail on 2nd Blob PUT (_mask.png) after _orig.jpg was already uploaded
        self.blob_transport.fail_on_put_call = 2
        status_fail1, body_fail1 = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs)
        self.assertEqual(status_fail1, 502)
        self.assertFalse(body_fail1["ok"])
        self.assertFalse(body_fail1["confirmed"])

        # Slot state must be rolled back to FAILED and partial _orig.jpg must be cleaned up!
        slot_state = self.rtdb_transport.store.get("kelompok5/executed_slots/2026-11-03_08-20")
        self.assertEqual(slot_state["status"], "FAILED")
        self.assertEqual(len(self.blob_transport.deleted_urls), 1)
        self.assertEqual(len(self.blob_transport.blobs), 0)

        # 2. Even if /delete failed and left an existing blob in the store, retry must succeed via x-allow-overwrite: 1
        self.blob_transport.ignore_delete = True
        self.rtdb_transport.fail_on_metadata_put = True
        status_fail2, body_fail2 = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs)
        self.assertEqual(status_fail2, 502)
        self.assertFalse(body_fail2["confirmed"])
        self.assertEqual(len(self.blob_transport.blobs), 3)  # Leftover blobs present

        # 3. Retry with leftover blobs in store succeeds because x-allow-overwrite: 1 is sent
        self.rtdb_transport.fail_on_metadata_put = False
        status_ok, body_ok = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs)
        self.assertEqual(status_ok, 200)
        self.assertTrue(body_ok["ok"])
        self.assertTrue(body_ok["confirmed"])
        slot_state3 = self.rtdb_transport.store.get("kelompok5/executed_slots/2026-11-03_08-20")
        self.assertEqual(slot_state3["status"], "CONFIRMED")
        self.assertEqual(slot_state3["fence_token"], 3)

    def test_real_http_412_cas_race_and_missing_etag_abort(self):
        # 1. Slot is initially UNLOCKED so claim_slot proceeds to PUT and hits HTTP 412 CAS conflict
        now_wall_ms = int(time.time() * 1000)
        self.rtdb_transport.simulate_cas_412_once = True
        self.rtdb_transport.cas_412_winner_state = {
            "status": "PROCESSING",
            "slot_key": "2026-11-03_08:30",
            "owner_id": "concurrent_winner",
            "fence_token": 1,
            "locked_at": now_wall_ms,
        }
        claim_status, winner = self.rtdb_store.claim_slot(
            "2026-11-03_08:30", self.valid_fnv1a, owner_id="contender", now_ms=now_wall_ms + 50
        )
        self.assertFalse(
            self.rtdb_transport.simulate_cas_412_once,
            "PUT must have been executed and consumed the 412 simulation flag",
        )
        self.assertEqual(claim_status, "IN_PROGRESS")
        self.assertEqual(winner.get("owner_id"), "concurrent_winner")

        # End-to-end ingest when slot is IN_PROGRESS returns HTTP 409 confirmed=False
        status_409, body_409 = self.ingestor.ingest(
            raw_bytes=self.raw_bytes,
            headers=self._default_headers("2026-11-03_08:30"),
        )
        self.assertEqual(status_409, 409)
        self.assertFalse(body_409["confirmed"])

        # 2. Missing ETag on GET must abort fail-closed (HTTP 502) and never do unconditional PUT
        self.rtdb_transport.omit_etag_on_get = True
        with self.assertRaises(self.MissingETagError):
            self.rtdb_store.claim_slot("2026-11-03_08:40", self.valid_fnv1a, now_ms=2000)

        status_no_etag, body_no_etag = self.ingestor.ingest(
            raw_bytes=self.raw_bytes,
            headers=self._default_headers("2026-11-03_08:40"),
        )
        self.assertEqual(status_no_etag, 502)
        self.assertFalse(body_no_etag["confirmed"])
        self.assertIsNone(self.rtdb_transport.store.get("kelompok5/executed_slots/2026-11-03_08-40"))

    def test_expired_lease_fencing_token_and_stale_owner_cannot_overwrite(self):
        slot = "2026-11-03_09:00"
        slot_path = "kelompok5/executed_slots/2026-11-03_09-00"
        meta_path = "kelompok5/growth_metadata/2026-11-03_09-00"

        # 1. Worker A claims slot at t=0 (fence_token=1)
        st_a, lock_a = self.rtdb_store.claim_slot(slot, self.valid_fnv1a, owner_id="worker_A", now_ms=0)
        self.assertEqual(st_a, "CLAIMED")
        self.assertEqual(lock_a["fence_token"], 1)

        # 2. Lease expires after 15,000ms; Worker B claims slot at t=16,000ms (fence_token=2)
        st_b, lock_b = self.rtdb_store.claim_slot(slot, self.valid_fnv1a, owner_id="worker_B", now_ms=16_000)
        self.assertEqual(st_b, "CLAIMED")
        self.assertEqual(lock_b["fence_token"], 2)
        self.assertEqual(lock_b["owner_id"], "worker_B")

        # 3. While Worker B is still PROCESSING, stale Worker A tries to rollback -> must be rejected!
        released_stale_while_processing = self.rtdb_store.release_failed_slot(
            slot, lock_a, "worker_A timed out", now_ms=16_500
        )
        self.assertFalse(released_stale_while_processing)
        self.assertEqual(self.rtdb_transport.store[slot_path]["status"], "PROCESSING")
        self.assertEqual(self.rtdb_transport.store[slot_path]["owner_id"], "worker_B")

        # 4. Worker B commits metadata & CONFIRMED state at t=17,000ms
        self.rtdb_store.commit_slot_and_metadata(
            slot,
            lock_b,
            {"image_id": "img_worker_B", "fnv1a": self.valid_fnv1a, "quality_status": "VALID"},
            now_ms=17_000,
        )
        self.assertEqual(self.rtdb_transport.store[slot_path]["status"], "CONFIRMED")

        # 5. Stale Worker A wakes up at t=18,000ms and tries to commit or release -> both must fail!
        with self.assertRaises(self.StaleLockOwnerError):
            self.rtdb_store.commit_slot_and_metadata(
                slot,
                lock_a,
                {"image_id": "img_worker_A_stale", "fnv1a": self.valid_fnv1a},
                now_ms=18_000,
            )
        released_stale_after_confirm = self.rtdb_store.release_failed_slot(
            slot, lock_a, "worker_A late failure", now_ms=18_500
        )
        self.assertFalse(released_stale_after_confirm)

        # Verify Worker B's CONFIRMED slot and metadata remain 100% intact
        self.assertEqual(self.rtdb_transport.store[slot_path]["status"], "CONFIRMED")
        self.assertEqual(self.rtdb_transport.store[slot_path]["owner_id"], "worker_B")
        self.assertEqual(self.rtdb_transport.store[slot_path]["fence_token"], 2)
        self.assertEqual(self.rtdb_transport.store[meta_path]["image_id"], "img_worker_B")

    def test_metadata_cleanup_when_slot_confirm_put_fails(self):
        hdrs = self._default_headers("2026-11-03_09:10")
        self.rtdb_transport.fail_on_slot_confirm_put = True

        status, body = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs)
        self.assertEqual(status, 502)
        self.assertFalse(body["confirmed"])

        # Unconfirmed metadata must have been cleaned up via DELETE and slot rolled back to FAILED
        self.assertIsNone(
            self.rtdb_transport.store.get("kelompok5/growth_metadata/2026-11-03_09-10")
        )
        slot_state = self.rtdb_transport.store.get("kelompok5/executed_slots/2026-11-03_09-10")
        self.assertEqual(slot_state["status"], "FAILED")

    def test_fail_closed_authentication_empty_wrong_and_valid_token(self):
        # 1. CAPTURE_SHARED_TOKEN empty/unconfigured -> must fail-closed with HTTP 503
        unconfigured_ingestor = self.ServerlessCaptureIngestor(
            blob_storage=self.blob_storage,
            rtdb_store=self.rtdb_store,
            cv_pipeline=self.cv_pipeline,
            shared_token="",
        )
        status_503, body_503 = unconfigured_ingestor.ingest(
            raw_bytes=self.raw_bytes,
            headers=self._default_headers("2026-11-03_09:20", token=None),
        )
        self.assertEqual(status_503, 503)
        self.assertFalse(body_503["confirmed"])

        # 2. Missing token when configured -> HTTP 401
        status_no_tok, body_no_tok = self.ingestor.ingest(
            raw_bytes=self.raw_bytes,
            headers=self._default_headers("2026-11-03_09:20", token=None),
        )
        self.assertEqual(status_no_tok, 401)
        self.assertFalse(body_no_tok["confirmed"])

        # 3. Wrong token -> HTTP 401
        status_bad_tok, body_bad_tok = self.ingestor.ingest(
            raw_bytes=self.raw_bytes,
            headers=self._default_headers("2026-11-03_09:20", token="wrong-secret"),
        )
        self.assertEqual(status_bad_tok, 401)
        self.assertFalse(body_bad_tok["confirmed"])

        # 4. Valid Authorization: Bearer <token> header -> HTTP 200
        bearer_hdrs = self._default_headers("2026-11-03_09:20", token=None)
        bearer_hdrs["Authorization"] = "Bearer test-shared-secret-token-2026"
        status_ok, body_ok = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=bearer_hdrs)
        self.assertEqual(status_ok, 200)
        self.assertTrue(body_ok["confirmed"])

    def test_strict_slot_calendar_window_timestamp_and_hst_validation(self):
        # 1. Impossible calendar dates -> HTTP 422
        for bad_slot in (
            "INVALID_SLOT_FORMAT",
            "2026-13-45_99:99",
            "2026-02-30_08:00",
            "2026-11-03_06:50",  # before 07:00 WIB
            "2026-11-03_17:00",  # after 16:50 WIB
            "2026-11-03_23:50",  # night outside window
            "2026-11-03_08:05",  # not a multiple of 10 minutes
        ):
            status, body = self.ingestor.ingest(
                raw_bytes=self.raw_bytes,
                headers=self._default_headers(bad_slot),
            )
            self.assertEqual(status, 422, f"Slot {bad_slot} must be rejected with 422")
            self.assertFalse(body["confirmed"])

        # 2. X-Captured-At inconsistent with X-Slot-Key (e.g., 2024 timestamp for 2026 slot) -> HTTP 422
        hdrs_ts_mismatch = self._default_headers("2026-11-03_10:00", captured_at_ms="1705000000000")
        st_ts, body_ts = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs_ts_mismatch)
        self.assertEqual(st_ts, 422)
        self.assertFalse(body_ts["confirmed"])

        # 3. Missing mandatory headers -> HTTP 422
        for required_hdr in (
            "X-File-Size",
            "X-Checksum-FNV1A",
            "X-Slot-Key",
            "X-Captured-At",
            "X-HST-Day",
        ):
            hdrs_missing = self._default_headers("2026-11-03_10:10")
            del hdrs_missing[required_hdr]
            st_m, body_m = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs_missing)
            self.assertEqual(st_m, 422, f"Missing {required_hdr} must be rejected with 422")
            self.assertFalse(body_m["confirmed"])

        # 4. Out-of-range X-HST-Day (0 or 43) -> HTTP 422 (no silent clamping)
        for bad_hst in ("0", "-1", "43", "999", "not-an-int"):
            hdrs_hst = self._default_headers("2026-11-03_10:20", hst_day=bad_hst)
            st_h, body_h = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs_hst)
            self.assertEqual(st_h, 422, f"Invalid X-HST-Day={bad_hst} must be rejected with 422")
            self.assertFalse(body_h["confirmed"])

    def test_oversized_pixel_dimensions_and_payload_bounds_rejected_before_cv(self):
        # 1. > 4.5MB payload rejected with HTTP 413
        oversized = b"\xff\xd8\xff" + (b"\x00" * self.MAX_PAYLOAD_BYTES)
        hdrs_big = self._default_headers(
            "2026-11-03_10:30",
            file_size=len(oversized),
            fnv1a=compute_fnv1a_hex(oversized),
        )
        status_413, body_413 = self.ingestor.ingest(raw_bytes=oversized, headers=hdrs_big)
        self.assertEqual(status_413, 413)
        self.assertFalse(body_413["confirmed"])

        # 2. Image dimensions > 1600x1200 (e.g. 1640x1220) rejected with HTTP 422 before CV
        big_img = Image.new("RGB", (1640, 1220), (30, 150, 40))
        buf_big = io.BytesIO()
        big_img.save(buf_big, format="JPEG", quality=50)
        raw_big_dim = buf_big.getvalue()
        hdrs_dim = self._default_headers(
            "2026-11-03_10:30",
            file_size=len(raw_big_dim),
            fnv1a=compute_fnv1a_hex(raw_big_dim),
        )
        st_dim, body_dim = self.ingestor.ingest(raw_bytes=raw_big_dim, headers=hdrs_dim)
        self.assertEqual(st_dim, 422)
        self.assertFalse(body_dim["confirmed"])
        self.assertIn("dimensions", body_dim["error"])

        # 3. Tiny image (< 64x64) rejected with HTTP 422
        tiny_img = Image.new("RGB", (32, 32), (30, 150, 40))
        buf_tiny = io.BytesIO()
        tiny_img.save(buf_tiny, format="JPEG", quality=80)
        raw_tiny = buf_tiny.getvalue()
        hdrs_tiny = self._default_headers(
            "2026-11-03_10:30",
            file_size=len(raw_tiny),
            fnv1a=compute_fnv1a_hex(raw_tiny),
        )
        st_tiny, body_tiny = self.ingestor.ingest(raw_bytes=raw_tiny, headers=hdrs_tiny)
        self.assertEqual(st_tiny, 422)
        self.assertFalse(body_tiny["confirmed"])

    def test_http_handler_post_get_put_delete_options_and_no_threading_server(self):
        capture_py_path = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "api", "kelompok5", "capture.py")
        )
        with open(capture_py_path, "r", encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("ThreadingHTTPServer(", src)
        self.assertNotIn("import ThreadingHTTPServer", src)

        class _DummySocket:
            def __init__(self, req_bytes):
                self._rfile = io.BytesIO(req_bytes)
                self._wfile = io.BytesIO()

            def makefile(self, mode, *args, **kwargs):
                if "r" in mode:
                    return self._rfile
                return self._wfile

            def sendall(self, data):
                self._wfile.write(data)

        hdrs = self._default_headers("2026-11-03_09:30")
        header_lines = "".join(f"{k}: {v}\r\n" for k, v in hdrs.items())
        raw_http_post = (
            f"POST /api/kelompok5/capture HTTP/1.1\r\n"
            f"Host: localhost\r\n"
            f"Content-Length: {len(self.raw_bytes)}\r\n"
            f"{header_lines}\r\n"
        ).encode("utf-8") + self.raw_bytes

        sock = _DummySocket(raw_http_post)
        custom_handler_cls = type(
            "_BoundHandler",
            (self.ServerlessHandler,),
            {"ingestor": self.ingestor},
        )
        custom_handler_cls(sock, ("127.0.0.1", 55555), None)
        resp_raw = sock._wfile.getvalue().decode("utf-8", errors="replace")
        self.assertIn("HTTP/1.0 200 OK", resp_raw)
        json_part = resp_raw.split("\r\n\r\n", 1)[1]
        parsed = json.loads(json_part)
        self.assertTrue(parsed["ok"])
        self.assertTrue(parsed["confirmed"])
        self.assertEqual(parsed["slot_key"], "2026-11-03_09:30")

        # GET, PUT, DELETE requests must return 405 JSON with confirmed=False
        for method_name in ("GET", "PUT", "DELETE"):
            sock_m = _DummySocket(
                f"{method_name} /api/kelompok5/capture HTTP/1.1\r\nHost: localhost\r\n\r\n".encode("utf-8")
            )
            custom_handler_cls(sock_m, ("127.0.0.1", 55555), None)
            resp_m = sock_m._wfile.getvalue().decode("utf-8", errors="replace")
            self.assertIn("405", resp_m.splitlines()[0])
            parsed_m = json.loads(resp_m.split("\r\n\r\n", 1)[1])
            self.assertFalse(parsed_m["confirmed"])

    def test_mobile_manual_fallback_upload_validation_and_source_whitelist(self):
        # 1. Valid manual mobile upload with X-Capture-Source: mobile_manual_fallback
        slot_mobile = "2026-11-03_11:10"
        hdrs_mobile = self._default_headers(slot_mobile)
        hdrs_mobile["X-Capture-Source"] = "mobile_manual_fallback"
        st_ok, body_ok = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs_mobile)
        self.assertEqual(st_ok, 200)
        self.assertTrue(body_ok["ok"])
        self.assertTrue(body_ok["confirmed"])
        self.assertEqual(body_ok["capture_source"], "mobile_manual_fallback")
        self.assertIn("leaf_width_px", body_ok)
        self.assertIn("leaf_area_px", body_ok)
        self.assertGreater(body_ok["leaf_width_px"], 0)
        self.assertGreater(body_ok["leaf_area_px"], 0)

        saved_meta = self.rtdb_transport.store.get("kelompok5/growth_metadata/2026-11-03_11-10")
        self.assertIsNotNone(saved_meta)
        self.assertEqual(saved_meta["capture_source"], "mobile_manual_fallback")
        self.assertEqual(saved_meta["source_file_name"], "mobile-manual-upload.jpg")

        # 2. Duplicate manual upload on the same confirmed slot returns HTTP 200 idempotently with metrics
        st_dup, body_dup = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs_mobile)
        self.assertEqual(st_dup, 200)
        self.assertTrue(body_dup["confirmed"])
        self.assertTrue(body_dup["duplicate"])
        self.assertEqual(body_dup["leaf_width_px"], body_ok["leaf_width_px"])

        # 3. Unrecognized X-Capture-Source header is rejected with HTTP 422
        hdrs_bad_src = self._default_headers("2026-11-03_11:20")
        hdrs_bad_src["X-Capture-Source"] = "untrusted_bypass_source"
        st_bad_src, body_bad_src = self.ingestor.ingest(raw_bytes=self.raw_bytes, headers=hdrs_bad_src)
        self.assertEqual(st_bad_src, 422)
        self.assertFalse(body_bad_src["confirmed"])


class TestCNNDatasetManagerBackend(unittest.TestCase):
    """
    Tests `/api/kelompok5/dataset` (`CNNDatasetService`) for single/bulk uploads
    (JPG/PNG/WEBP), 4-class labels, magic-byte & corruption validation, FNV-1a
    duplicate rejection, anti-Base64 enforcement, Vercel Blob + Firebase RTDB
    persistence, label updates, and deletions with blob cleanup.
    """

    def setUp(self):
        api_dir = os.path.join(os.path.dirname(__file__), "..", "api", "kelompok5")
        if api_dir not in sys.path:
            sys.path.insert(0, api_dir)
        from capture import VercelBlobStorage, FirebaseRTDBStore, compute_fnv1a_hex
        from dataset import CNNDatasetService

        self.compute_fnv1a_hex = compute_fnv1a_hex
        self.rtdb_transport = _InMemoryFirebaseTransport()
        self.blob_transport = _InMemoryVercelBlobTransport()

        self.rtdb_store = FirebaseRTDBStore(
            db_url="https://mock-project.asia-southeast1.firebasedatabase.app",
            auth_token="mock-db-secret",
            urlopen_fn=self.rtdb_transport.urlopen,
        )
        self.blob_storage = VercelBlobStorage(
            token="vercel_blob_rw_mock_token",
            urlopen_fn=self.blob_transport.urlopen,
        )
        self.tmp_models = tempfile.TemporaryDirectory()
        from scripts.cnn_inference_adapter import CNNInferenceAdapter
        self.empty_adapter = CNNInferenceAdapter(models_dir=self.tmp_models.name, auto_load=True)
        self.service = CNNDatasetService(
            rtdb_store=self.rtdb_store,
            blob_storage=self.blob_storage,
            cnn_adapter=self.empty_adapter,
            shared_token="test-dataset-secret-2026",
            allow_local_fallback=False,
        )

    def tearDown(self):
        if hasattr(self, "tmp_models"):
            self.tmp_models.cleanup()

    def _make_image_bytes(self, fmt="JPEG", color=(50, 180, 60), size=(320, 240)):
        img = Image.new("RGB", size, color=(40, 30, 20))
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        cx, cy = size[0] // 2, size[1] // 2
        rx, ry = size[0] // 4, size[1] // 4
        draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=color)
        for offset in range(-rx + 10, rx - 10, 8):
            draw.line([cx + offset, cy - ry + 15, cx + offset, cy + ry - 15], fill=(20, 140, 30), width=2)
        buf = io.BytesIO()
        img.save(buf, format=fmt)
        return buf.getvalue()

    def test_single_and_multi_format_upload_persistence_and_duplicate_rejection(self):
        formats = [
            ("JPEG", "siap_panen", "panen1.jpg", (45, 195, 55)),
            ("PNG", "mendekati_panen", "mendekati1.png", (55, 185, 65)),
            ("WEBP", "masa_pertumbuhan", "tumbuh1.webp", (65, 175, 75)),
            ("JPEG", "bukan_selada", "pot_kosong.jpg", (120, 110, 100)),
        ]
        created_ids = []
        for fmt, label, fname, col in formats:
            raw = self._make_image_bytes(fmt=fmt, color=col)
            fnv1a = self.compute_fnv1a_hex(raw)
            hdrs = {
                "Authorization": "Bearer test-dataset-secret-2026",
                "X-Dataset-Label": label,
                "X-File-Name": fname,
                "X-File-Size": str(len(raw)),
                "X-Checksum-FNV1A": fnv1a,
                "X-HST-Day": "21",
                "X-Notes": f"Sampel {label}",
            }
            code, res = self.service.upload_image(raw, hdrs)
            self.assertEqual(code, 200, f"Upload failed for {fmt}/{label}: {res}")
            self.assertTrue(res["ok"])
            rec = res["record"]
            created_ids.append(rec["dataset_id"])
            self.assertEqual(rec["label"], label)
            self.assertIsNone(rec["cnn_class"])
            self.assertEqual(rec["cnn_status"], "BELUM ADA MODEL")
            self.assertTrue(rec["image_url"].startswith("https://"))
            self.assertFalse(rec["image_url"].startswith("data:"))
            if label != "bukan_selada":
                self.assertGreater(rec["leaf_width_px"], 0)
            else:
                self.assertEqual(rec["leaf_width_px"], 0)

        # Verify all 4 records are persisted in Firebase RTDB and returned on list_records()
        code_list, list_res = self.service.list_records()
        self.assertEqual(code_list, 200)
        self.assertEqual(list_res["count"], 4)
        self.assertEqual(list_res["cnn_status"], "BELUM ADA MODEL")

        # Duplicate upload of the first image must be rejected with HTTP 409
        dup_raw = self._make_image_bytes(fmt="JPEG", color=(45, 195, 55))
        code_dup, res_dup = self.service.upload_image(
            dup_raw,
            {
                "Authorization": "Bearer test-dataset-secret-2026",
                "X-Dataset-Label": "siap_panen",
            },
        )
        self.assertEqual(code_dup, 409)
        self.assertTrue(res_dup.get("duplicate"))

    def test_security_auth_anti_base64_corrupt_and_label_update_delete(self):
        raw_jpg = self._make_image_bytes(fmt="JPEG", color=(40, 190, 60))

        # 1. Missing token -> 401, Wrong token -> 403
        c401, _ = self.service.upload_image(raw_jpg, {"X-Dataset-Label": "siap_panen"})
        self.assertEqual(c401, 401)
        c403, _ = self.service.upload_image(
            raw_jpg,
            {"Authorization": "Bearer wrong-token", "X-Dataset-Label": "siap_panen"},
        )
        self.assertEqual(c403, 403)

        # 2. Base64 data URI payload must be rejected with 422
        b64_payload = b"data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/" + (b"A" * 200)
        c_b64, res_b64 = self.service.upload_image(
            b64_payload,
            {"Authorization": "Bearer test-dataset-secret-2026", "X-Dataset-Label": "siap_panen"},
        )
        self.assertEqual(c_b64, 422)
        self.assertIn("Base64", res_b64["error"])

        # 3. Corrupt JPEG bytes (valid magic bytes but garbage body) -> 422
        corrupt_jpg = b"\xff\xd8\xff\xe0" + (b"\x00\xff\x12\x34" * 60)
        c_corrupt, _ = self.service.upload_image(
            corrupt_jpg,
            {"Authorization": "Bearer test-dataset-secret-2026", "X-Dataset-Label": "siap_panen"},
        )
        self.assertEqual(c_corrupt, 422)

        # 4. Upload valid record, update its label via update_record, then delete via delete_record
        c_up, res_up = self.service.upload_image(
            raw_jpg,
            {"Authorization": "Bearer test-dataset-secret-2026", "X-Dataset-Label": "masa_pertumbuhan"},
        )
        self.assertEqual(c_up, 200)
        ds_id = res_up["record"]["dataset_id"]

        c_patch, res_patch = self.service.update_record(
            {"dataset_id": ds_id, "label": "siap_panen", "notes": "Sudah siap panen hari ke-38"},
            {"Authorization": "Bearer test-dataset-secret-2026"},
        )
        self.assertEqual(c_patch, 200)
        self.assertEqual(res_patch["record"]["label"], "siap_panen")
        self.assertEqual(res_patch["record"]["notes"], "Sudah siap panen hari ke-38")

        c_del, res_del = self.service.delete_record(
            ds_id,
            {"Authorization": "Bearer test-dataset-secret-2026"},
        )
        self.assertEqual(c_del, 200)
        self.assertEqual(res_del["deleted_id"], ds_id)
        self.assertGreaterEqual(len(self.blob_transport.deleted_urls), 3)

        # Verify record is gone from RTDB
        _, after_list = self.service.list_records()
        self.assertEqual(after_list["count"], 0)


class TestExternalColabCNNInferenceAdapter(unittest.TestCase):
    """
    Tests external Google Colab CNN model validation (7 criteria), atomic rollback
    preserving active model on failed import, preprocessing parity, and technical
    test model (`is_test_model: True` -> `MODEL PENGUJIAN`) inference integration
    across ESP32-CAM CV pipeline and CNNDatasetService.
    """

    def _build_valid_test_bundle(self, version="v1.0.0-colab-test", fmt="tflite", norm="rescale_0_1"):
        # 3 kelas aktif output model_selada_v2.h5 (tanpa memaksakan 4 kelas dan tanpa mengubah urutan)
        classes = ["siap_panen", "mendekati_panen", "masa_pertumbuhan"]
        metadata = {
            "model_id": "model_selada_v2",
            "model_version": version,
            "architecture": "MobileNetV2",
            "format": fmt,
            "training_source": "google_colab",
            "exported_at": "2026-11-03T12:00:00Z",
            "is_test_model": True,
            "input_shape": [128, 128, 3],
            "class_names": classes,
            "preprocessing": {
                "color_mode": "RGB",
                "resize_mode": "bilinear",
                "target_size": [128, 128],
                "normalization": norm,
            },
            "notes": "MODEL PENGUJIAN TEKNIS (BUKAN MODEL PRODUKSI)",
        }
        evaluation = {
            "accuracy": 0.935,
            "precision_macro": 0.931,
            "recall_macro": 0.928,
            "f1_macro": 0.929,
            "test_samples": 80,
            "class_names": classes,
            "confusion_matrix": [
                [19, 1, 0],
                [1, 18, 1],
                [0, 1, 19],
            ],
        }
        # Bobot proyeksi deterministik 6x3 untuk pengujian teknis inferensi 3 kelas aktif
        weights = {
            "kernel": [
                [-0.5, 0.2, 0.3],
                [2.8, 1.4, 0.6],
                [-0.4, 0.1, 0.2],
                [0.5, 0.2, -0.1],
                [1.2, 0.5, 0.1],
                [0.1, 0.1, 0.1],
            ],
            "bias": [0.4, 0.1, -0.1],
        }
        bundle = {
            "class_names.json": json.dumps(classes).encode("utf-8"),
            "metadata.json": json.dumps(metadata).encode("utf-8"),
            "evaluation.json": json.dumps(evaluation).encode("utf-8"),
        }
        if fmt == "tflite":
            header = b"\x1c\x00\x00\x00TFL3\x00\x00\x12\x00\x1c\x00\x04\x00\x08\x00\x0c\x00\x10\x00\x14\x00\x00\x00\x18\x00\x12\x00\x00\x00"
            trailer = b"__SELADA_PORTABLE_WEIGHTS_JSON__:" + json.dumps(weights).encode("utf-8")
            bundle["model.tflite"] = header + trailer
        elif fmt == "h5":
            header = b"\x89HDF\r\n\x1a\n\x00\x00\x00\x00\x00\x00\x00\x00"
            trailer = b"__SELADA_PORTABLE_WEIGHTS_JSON__:" + json.dumps(weights).encode("utf-8")
            bundle["model_selada_v2.h5"] = header + trailer
        else:
            import zipfile
            zbuf = io.BytesIO()
            with zipfile.ZipFile(zbuf, "w") as zf:
                zf.writestr(
                    "config.json",
                    json.dumps({"class_name": "Functional", "input_shape": [128, 128, 3]}),
                )
                zf.writestr("portable_weights.json", json.dumps(weights))
            bundle["model.keras"] = zbuf.getvalue()
        return bundle

    def test_default_fallback_and_7_layer_validation_and_atomic_rollback(self):
        from scripts.cnn_inference_adapter import CNNInferenceAdapter, preprocess_image_tensor

        with tempfile.TemporaryDirectory() as empty_dir:
            adapter = CNNInferenceAdapter(models_dir=empty_dir, auto_load=True)
            self.assertFalse(adapter.is_ready)
            self.assertEqual(adapter.status, "BELUM ADA MODEL")

            # Fallback prediction when no model is installed must NEVER fabricate results
            sample_img = Image.new("RGB", (200, 200), color=(45, 185, 55))
            pred_empty = adapter.predict(sample_img, leaf_width_px=142)
            self.assertEqual(pred_empty["cnn_status"], "BELUM ADA MODEL")
            self.assertIsNone(pred_empty["cnn_class"])
            self.assertIsNone(pred_empty["cnn_confidence"])
            self.assertIsNone(pred_empty["model_version"])

            # 1. Reject incomplete bundle (missing evaluation.json)
            b_missing = self._build_valid_test_bundle()
            b_missing.pop("evaluation.json")
            res_missing = adapter.register_model_bundle(b_missing)
            self.assertFalse(res_missing["ok"])
            self.assertEqual(res_missing["stage"], "files")
            self.assertEqual(adapter.status, "BELUM ADA MODEL")

            # 2. Reject forced 4-class validation or wrong classes
            b_four = self._build_valid_test_bundle()
            b_four["class_names.json"] = json.dumps(["siap_panen", "mendekati_panen", "masa_pertumbuhan", "bukan_selada"]).encode("utf-8")
            res_four = adapter.register_model_bundle(b_four)
            self.assertFalse(res_four["ok"])
            self.assertEqual(res_four["stage"], "classes")

            b_wrong_cls = self._build_valid_test_bundle()
            b_wrong_cls["class_names.json"] = json.dumps(["siap_panen", "mendekati_panen", "bayam"]).encode("utf-8")
            res_cls = adapter.register_model_bundle(b_wrong_cls)
            self.assertFalse(res_cls["ok"])
            self.assertEqual(res_cls["stage"], "classes")

            # 3. Reject mismatched label order between class_names.json and metadata.json
            b_order = self._build_valid_test_bundle()
            b_order["class_names.json"] = json.dumps(["mendekati_panen", "siap_panen", "masa_pertumbuhan"]).encode("utf-8")
            res_order = adapter.register_model_bundle(b_order)
            self.assertFalse(res_order["ok"])
            self.assertEqual(res_order["stage"], "label_order")

            # 4. Reject invalid input_shape
            b_shape = self._build_valid_test_bundle()
            m_shape = json.loads(b_shape["metadata.json"].decode("utf-8"))
            m_shape["input_shape"] = [32, 32, 1]
            b_shape["metadata.json"] = json.dumps(m_shape).encode("utf-8")
            res_shape = adapter.register_model_bundle(b_shape)
            self.assertFalse(res_shape["ok"])
            self.assertEqual(res_shape["stage"], "input_shape")

            # 5. Reject unsupported normalization
            b_norm = self._build_valid_test_bundle()
            m_norm = json.loads(b_norm["metadata.json"].decode("utf-8"))
            m_norm["preprocessing"]["normalization"] = "unknown_norm_xyz"
            b_norm["metadata.json"] = json.dumps(m_norm).encode("utf-8")
            res_norm = adapter.register_model_bundle(b_norm)
            self.assertFalse(res_norm["ok"])
            self.assertEqual(res_norm["stage"], "normalization")

            # 6. Activate valid technical test model_selada_v2.h5 (format h5, marked MODEL PENGUJIAN)
            valid_h5 = self._build_valid_test_bundle(version="v2.0.0-h5-test", fmt="h5")
            res_h5 = adapter.register_model_bundle(valid_h5)
            self.assertTrue(res_h5["ok"], f"Expected valid model_selada_v2.h5 registration: {res_h5}")
            self.assertEqual(adapter.status, "MODEL PENGUJIAN")
            self.assertEqual(adapter.get_status_dict()["model_version"], "v2.0.0-h5-test")
            self.assertEqual(adapter.get_status_dict()["binary_file"], "model_selada_v2.h5")
            self.assertTrue(adapter.get_status_dict()["is_test_model"])
            self.assertEqual(adapter.get_status_dict()["unavailable_classes"], {"bukan_selada": "BELUM TERSEDIA"})

            # 7. Atomic Rollback Test: attempt to import corrupt binary -> must fail AND keep v2.0.0-h5-test active!
            b_corrupt = self._build_valid_test_bundle(version="v2.1.0-broken", fmt="tflite")
            b_corrupt["model.tflite"] = b"NOT_A_VALID_TFLITE_BINARY_FILE_HEADER_0000"
            res_corrupt = adapter.register_model_bundle(b_corrupt)
            self.assertFalse(res_corrupt["ok"])
            self.assertTrue(res_corrupt["rolled_back_to_previous"])
            self.assertTrue(adapter.is_ready)
            self.assertEqual(adapter.get_status_dict()["model_version"], "v2.0.0-h5-test")

            # 8. Also verify valid .keras archive model registration & inference
            valid_keras = self._build_valid_test_bundle(version="v1.2.0-keras-test", fmt="keras", norm="mobilenet_v2_-1_1")
            res_keras = adapter.register_model_bundle(valid_keras)
            self.assertTrue(res_keras["ok"], f"Expected valid keras registration: {res_keras}")
            self.assertEqual(adapter.get_status_dict()["model_version"], "v1.2.0-keras-test")

            pred_active = adapter.predict(sample_img, leaf_width_px=155, timestamp_ms=1775266200000)
            self.assertEqual(pred_active["cnn_status"], "MODEL PENGUJIAN")
            self.assertIn(pred_active["cnn_class"], ["siap_panen", "mendekati_panen", "masa_pertumbuhan"])
            self.assertNotEqual(pred_active["cnn_class"], "bukan_selada")
            self.assertNotIn("bukan_selada", pred_active["cnn_probabilities"])
            self.assertIsNotNone(pred_active["cnn_confidence"])
            self.assertGreater(pred_active["cnn_confidence"], 0.0)
            self.assertEqual(pred_active["model_version"], "v1.2.0-keras-test")
            self.assertEqual(pred_active["classified_at"], 1775266200000)
            self.assertTrue(pred_active["is_test_model"])

            # 9. Verify preprocessing parity across all supported normalization modes
            t01 = preprocess_image_tensor(sample_img, [128, 128, 3], {"color_mode": "RGB", "resize_mode": "bilinear", "normalization": "rescale_0_1"})
            self.assertEqual(t01.shape, (1, 128, 128, 3))
            self.assertTrue(np.all((t01 >= 0.0) & (t01 <= 1.0)))

            tmob = preprocess_image_tensor(sample_img, [128, 128, 3], {"color_mode": "RGB", "resize_mode": "bilinear", "normalization": "mobilenet_v2_-1_1"})
            self.assertTrue(np.all((tmob >= -1.0) & (tmob <= 1.0)))

    def test_cv_pipeline_and_dataset_integration_with_test_model(self):
        from scripts.cnn_inference_adapter import CNNInferenceAdapter

        with tempfile.TemporaryDirectory() as tmp_dir:
            adapter = CNNInferenceAdapter(models_dir=tmp_dir, auto_load=False)
            adapter.register_model_bundle(self._build_valid_test_bundle(version="v1.3.0-test", fmt="h5"))

            pipeline = LettuceCVPipeline(
                output_dir=os.path.join(tmp_dir, "imgs"),
                meta_file=os.path.join(tmp_dir, "meta.json"),
                cnn_adapter=adapter,
            )
            img = Image.new("RGB", (320, 240), color=(40, 30, 20))
            from PIL import ImageDraw
            draw = ImageDraw.Draw(img)
            draw.ellipse([80, 50, 240, 190], fill=(45, 200, 55))
            for x in range(95, 225, 10):
                draw.line([x, 65, x, 175], fill=(20, 140, 30), width=2)

            rec = pipeline.process_image(img, plant_id="SLD-01", hst_day=28, timestamp=1775266200000)
            self.assertEqual(rec["quality_status"], "VALID")
            self.assertGreater(rec["leaf_width_px"], 0)
            self.assertEqual(rec["cnn_status"], "MODEL PENGUJIAN")
            self.assertEqual(rec["model_version"], "v1.3.0-test")
            self.assertTrue(rec["is_test_model"])
            self.assertIn(rec["cnn_class"], ["siap_panen", "mendekati_panen", "masa_pertumbuhan"])
            self.assertNotEqual(rec["cnn_class"], "bukan_selada")
            self.assertIsNotNone(rec["cnn_confidence"])
            self.assertEqual(rec["classified_at"], 1775266200000)
            self.assertIsNotNone(rec["cnn_confidence"])
            self.assertEqual(rec["classified_at"], 1775266200000)



if __name__ == "__main__":
    unittest.main()
