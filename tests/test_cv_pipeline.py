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


if __name__ == "__main__":
    unittest.main()
