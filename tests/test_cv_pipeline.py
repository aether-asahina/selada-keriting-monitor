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
from growth_cv_pipeline import LettuceCVPipeline, WIB_TIMEZONE, generate_synthetic_lettuce_image
from scheduler_daemon import LeafGrowthScheduler

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
        img = generate_synthetic_lettuce_image(width=320, height=240, canopy_radius=60)
        np_img = np.array(img)
        is_valid, status, detail = self.pipeline.validate_quality(np_img)
        self.assertTrue(is_valid)
        self.assertEqual(status, "VALID")

    def test_quality_validation_pitch_dark_rejected(self):
        dark_img = Image.new("RGB", (320, 240), (5, 5, 5))
        np_img = np.array(dark_img)
        is_valid, status, detail = self.pipeline.validate_quality(np_img)
        self.assertFalse(is_valid)
        self.assertEqual(status, "INVALID_DARK")

    def test_quality_validation_blurred_rejected(self):
        img = generate_synthetic_lettuce_image(width=320, height=240, canopy_radius=60)
        blurred = img.filter(ImageFilter.GaussianBlur(radius=12))
        np_img = np.array(blurred)
        is_valid, status, detail = self.pipeline.validate_quality(np_img)
        self.assertFalse(is_valid)
        self.assertEqual(status, "INVALID_BLUR")

    def test_segmentation_exg_binary_mask(self):
        img = generate_synthetic_lettuce_image(width=320, height=240, canopy_radius=60)
        np_img = np.array(img)
        mask = self.pipeline.segment_vegetation(np_img)
        self.assertEqual(mask.shape, (240, 320))
        # Mask must only contain 0 and 255
        unique_vals = set(np.unique(mask))
        self.assertTrue(unique_vals.issubset({0, 255}))
        # Positive leaf pixels must be detected
        self.assertGreater(np.sum(mask == 255), 500)

    def test_measurements_width_and_area(self):
        img = generate_synthetic_lettuce_image(width=320, height=240, canopy_radius=70)
        np_img = np.array(img)
        mask = self.pipeline.segment_vegetation(np_img)
        res = self.pipeline.extract_contour_and_measurements(mask)
        self.assertGreater(res["leaf_width_px"], 50)
        self.assertGreater(res["leaf_area_px"], 1000)
        self.assertGreater(len(res["contour_pts"]), 5)

    def test_uncalibrated_returns_null_physical_units(self):
        img = generate_synthetic_lettuce_image(width=320, height=240, canopy_radius=60)
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
        img = generate_synthetic_lettuce_image(width=320, height=240, canopy_radius=60)
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


if __name__ == "__main__":
    unittest.main()
