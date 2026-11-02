#!/usr/bin/env python3
"""
==============================================================================
AUTOMATED 10-MINUTE CAPTURE SCHEDULER DAEMON FOR LETTUCE GROWTH MONITORING
Species: Lactuca sativa L. var. crispa (Selada Keriting)
Cycle: 42 Hari Setelah Tanam (HST)
Schedule: Every 10 minutes from 07:00 WIB to 16:50 WIB daily (60 slots/day)
Target: Minimum 1,600 verified valid images over 2,520 total opportunities.
Features:
  - Runs independent of browser / UI
  - Timezone Asia/Jakarta (WIB, UTC+7)
  - Duplicate capture prevention
  - Automatic restart & crash recovery
  - Camera connection timeout & exponential backoff retry (max 3)
  - Accurate failure logging without synthetic replacement data
==============================================================================
"""

import os
import sys
import time
import json
import argparse
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from io import BytesIO
from PIL import Image

# Import computer vision pipeline
try:
    from growth_cv_pipeline import LettuceCVPipeline, WIB_TIMEZONE
except ImportError:
    from scripts.growth_cv_pipeline import LettuceCVPipeline, WIB_TIMEZONE

# ----------------------------------------------------------------------------
# Campaign Specifications
# ----------------------------------------------------------------------------
CONFIG = {
    "total_days": 42,
    "target_valid_images": 1600,
    "start_time_wib": "07:00",
    "end_time_wib": "16:50",
    "slot_interval_minutes": 10,
    "camera_host": "192.168.1.105", # Default ESP32-CAM LAN IP
    "camera_timeout_seconds": 6,
    "max_retries": 3,
    "retry_delay_seconds": 2,
    "plant_id": "SLD-01",
    "camera_id": "ESP32-CAM-01",
    "metadata_path": "data/growth_metadata.json",
    "images_dir": "data/growth_images",
    "log_file": "data/scheduler_daemon.log"
}

def log(msg, level="INFO", log_file=None):
    dt_wib = datetime.now(WIB_TIMEZONE)
    timestamp_str = dt_wib.strftime("%Y-%m-%d %H:%M:%S WIB")
    line = f"[{timestamp_str}] [{level}] {msg}"
    print(line)
    target_log = log_file or CONFIG["log_file"]
    try:
        log_dir = os.path.dirname(target_log)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        with open(target_log, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

class LeafGrowthScheduler:
    def __init__(self, config=None):
        self.cfg = config or CONFIG
        self.log_file = self.cfg.get("log_file", CONFIG["log_file"])
        self.pipeline = LettuceCVPipeline(
            output_dir=self.cfg["images_dir"],
            meta_file=self.cfg["metadata_path"],
            calib_factor_mm_per_px=self.cfg.get("calib_factor_mm_per_px", None)
        )
        self.executed_slots = set()
        self.load_history()

    def _log(self, msg, level="INFO"):
        log(msg, level=level, log_file=self.log_file)

    def get_wib_now(self):
        return datetime.now(WIB_TIMEZONE)

    def get_slot_key(self, dt):
        minute_bucket = (dt.minute // self.cfg["slot_interval_minutes"]) * self.cfg["slot_interval_minutes"]
        return f"{dt.strftime('%Y-%m-%d')}_{dt.hour:02d}:{minute_bucket:02d}"

    def is_within_window(self, dt):
        start_h, start_m = map(int, self.cfg["start_time_wib"].split(":"))
        end_h, end_m = map(int, self.cfg["end_time_wib"].split(":"))

        current_mins = dt.hour * 60 + dt.minute
        start_mins = start_h * 60 + start_m
        end_mins = end_h * 60 + end_m

        return start_mins <= current_mins <= end_mins

    def load_history(self):
        """Recovery on restart: Load existing slots from metadata JSON."""
        meta_file = self.cfg["metadata_path"]
        if os.path.exists(meta_file):
            try:
                with open(meta_file, "r", encoding="utf-8") as f:
                    records = json.load(f)
                    for r in records:
                        if "captured_at" in r:
                            dt = datetime.fromtimestamp(r["captured_at"] / 1000, tz=WIB_TIMEZONE)
                            self.executed_slots.add(self.get_slot_key(dt))
                self._log(f"Recovery complete. Loaded {len(self.executed_slots)} historical execution slots.")
            except Exception as e:
                self._log(f"Failed to read historical metadata: {e}", "WARN")

    def capture_from_camera(self, host):
        """Attempts HTTP snapshot capture from physical ESP32-CAM."""
        snapshot_url = f"http://{host}/capture"
        req = urllib.request.Request(snapshot_url, headers={"User-Agent": "SeladaMonitor-Scheduler/1.0"})
        
        for attempt in range(1, self.cfg["max_retries"] + 1):
            try:
                self._log(f"Attempting camera capture from {snapshot_url} (attempt {attempt}/{self.cfg['max_retries']})...")
                with urllib.request.urlopen(req, timeout=self.cfg["camera_timeout_seconds"]) as resp:
                    if resp.status == 200:
                        img_bytes = resp.read()
                        pil_img = Image.open(BytesIO(img_bytes)).convert("RGB")
                        self._log("Camera capture successful.")
                        return pil_img, None
            except Exception as e:
                self._log(f"Capture attempt {attempt} failed: {e}", "WARN")
                if attempt < self.cfg["max_retries"]:
                    time.sleep(self.cfg["retry_delay_seconds"])
        
        return None, f"ESP32-CAM unreachable at {host} after {self.cfg['max_retries']} retries"

    def record_failure(self, slot_key, error_msg, dt_wib, hst_day):
        """Records genuine capture failure without generating fake measurements."""
        now_ts = int(dt_wib.timestamp() * 1000)
        image_id = f"err_{dt_wib.strftime('%Y%m%d_%H%M%S')}"

        record = {
            "image_id": image_id,
            "plant_id": self.cfg["plant_id"],
            "captured_at": now_ts,
            "time_wib": dt_wib.strftime("%Y-%m-%d %H:%M:%S WIB"),
            "hst_day": hst_day,
            "leaf_width_px": 0,
            "leaf_width_mm": None,
            "leaf_area_px": 0,
            "leaf_area_mm2": None,
            "quality_status": "INVALID_OFFLINE",
            "quality_detail": f"Gagal capture: {error_msg}",
            "processing_status": "FAILED",
            "camera_id": self.cfg["camera_id"],
            "algorithm_version": self.pipeline.algo_version,
            "image_url": "",
            "mask_url": "",
            "overlay_url": ""
        }

        self.pipeline._append_metadata(record)
        self.executed_slots.add(slot_key)
        self._log(f"Recorded capture failure for slot {slot_key}: {error_msg}", "ERROR")
        return record

    def run_slot(self, force=False, hst_day=1):
        """Executes a 10-minute capture slot with 100% genuine data discipline."""
        now_wib = self.get_wib_now()
        slot_key = self.get_slot_key(now_wib)

        if not force and slot_key in self.executed_slots:
            self._log(f"Slot {slot_key} already executed. Skipping to prevent duplicate.")
            return None

        if not force and not self.is_within_window(now_wib):
            self._log(f"Current time {now_wib.strftime('%H:%M WIB')} is outside capture window ({self.cfg['start_time_wib']} - {self.cfg['end_time_wib']} WIB).")
            return None

        self._log(f"=== Starting Scheduled Capture Slot: {slot_key} ===")
        pil_img, err = self.capture_from_camera(self.cfg["camera_host"])

        if pil_img is None:
            # Strictly record real failure without synthesizing fake rosette images or fake measurements
            return self.record_failure(slot_key, err, now_wib, hst_day)

        # Process genuine physical camera frame through Computer Vision Pipeline
        now_ts = int(now_wib.timestamp() * 1000)
        res = self.pipeline.process_image(
            input_image=pil_img,
            plant_id=self.cfg["plant_id"],
            hst_day=hst_day,
            timestamp=now_ts,
            camera_id=self.cfg["camera_id"]
        )

        self.executed_slots.add(slot_key)
        self._log(f"Slot {slot_key} completed successfully: Width={res['leaf_width_px']}px, Area={res['leaf_area_px']}px2, QC={res['quality_status']}")
        return res

    def print_status(self):
        """Prints campaign execution status report."""
        meta_file = self.cfg["metadata_path"]
        records = []
        if os.path.exists(meta_file):
            try:
                with open(meta_file, "r", encoding="utf-8") as f:
                    records = json.load(f)
            except Exception:
                records = []

        total = len(records)
        valid = sum(1 for r in records if r.get("quality_status") == "VALID")
        failed = total - valid
        target = self.cfg["target_valid_images"]
        pct = min(100.0, (valid / target) * 100) if target else 0

        print("==================================================================")
        print(" SELADA KERITING 42-DAY AUTOMATED GROWTH CAMPAIGN STATUS REPORT   ")
        print("==================================================================")
        print(f" Timezone           : Asia/Jakarta (WIB, UTC+7)")
        print(f" Daily Window       : {self.cfg['start_time_wib']} - {self.cfg['end_time_wib']} WIB ({60} slots/day)")
        print(f" Total Campaign Slots: 2,520 opportunities (42 Days x 60 slots)")
        print(f" Total Captures Run : {total}")
        print(f" Valid Images Passed: {valid} / {target} target ({pct:.1f}%)")
        print(f" Failed Captures    : {failed}")
        print(f" Camera Endpoint    : http://{self.cfg['camera_host']}/capture")
        print(" Data Authenticity  : 100% REAL DATA ONLY (Zero Simulation/Synthetic)")
        print("==================================================================")

    def run_daemon(self, poll_interval_sec=15):
        """Runs the continuous scheduler daemon loop."""
        self._log("Leaf Growth Scheduler Daemon started. Monitoring slots...")
        self.print_status()

        while True:
            try:
                now = self.get_wib_now()
                # Trigger on 10-minute boundary (e.g. 00, 10, 20, 30, 40, 50)
                if (now.minute % self.cfg["slot_interval_minutes"] == 0) and self.is_within_window(now):
                    slot_key = self.get_slot_key(now)
                    if slot_key not in self.executed_slots:
                        self.run_slot()
                time.sleep(poll_interval_sec)
            except KeyboardInterrupt:
                self._log("Scheduler Daemon stopped by user.")
                break
            except Exception as e:
                self._log(f"Unexpected error in daemon loop: {e}", "ERROR")
                time.sleep(poll_interval_sec)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Automated 10-Minute Lettuce Growth Scheduler Daemon")
    parser.add_argument("--run-once", action="store_true", help="Execute single capture slot immediately")
    parser.add_argument("--daemon", action="store_true", help="Run continuous scheduler daemon")
    parser.add_argument("--status", action="store_true", help="Display campaign progress report")
    parser.add_argument("--camera-host", type=str, default=CONFIG["camera_host"], help="ESP32-CAM IP or hostname")

    args = parser.parse_args()
    if args.camera_host:
        CONFIG["camera_host"] = args.camera_host

    scheduler = LeafGrowthScheduler(CONFIG)

    if args.status:
        scheduler.print_status()
    elif args.run_once:
        scheduler.run_slot(force=True)
    elif args.daemon:
        scheduler.run_daemon()
    else:
        scheduler.print_status()
