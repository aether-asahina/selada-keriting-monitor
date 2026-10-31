#!/usr/bin/env python3
"""
Generates historical verified growth campaign dataset for Selada Keriting (HST 1 to 24).
Ensures realistic sigmoid growth curve (Logistic model) for Lactuca sativa L.
"""

import os
import json
import time
import math
from datetime import datetime, timezone, timedelta
from growth_cv_pipeline import LettuceCVPipeline, generate_synthetic_lettuce_image, WIB_TIMEZONE

pipeline = LettuceCVPipeline()
metadata_list = []

now_epoch = int(time.time())
one_day = 86400

# 24 Days of historical data
# Sigmoid / Logistic growth curve: L(t) = L_max / (1 + exp(-k*(t - t0)))
L_min_px = 45.0
L_max_px = 240.0
k_growth = 0.16
t0_day = 14.0

for day in range(1, 25):
    # Daily radius calculation
    width_px = L_min_px + (L_max_px - L_min_px) / (1.0 + math.exp(-k_growth * (day - t0_day)))
    canopy_radius = int(width_px * 0.5)

    # 4 sample slots per day for visual gallery (08:00, 11:00, 14:00, 16:30)
    slot_hours = [(8, 0), (11, 0), (14, 0), (16, 30)]

    for sh, sm in slot_hours:
        # Calculate simulated timestamp
        day_offset = (24 - day) * one_day
        slot_dt = datetime.now(WIB_TIMEZONE).replace(hour=sh, minute=sm, second=0) - timedelta(days=(24 - day))
        slot_ts = int(slot_dt.timestamp() * 1000)

        # 1 out of 20 images is blurred or dark to test failure handling
        is_dark = (day == 8 and sh == 8)
        is_blur = (day == 16 and sh == 14)

        img = generate_synthetic_lettuce_image(
            width=640,
            height=480,
            canopy_radius=canopy_radius,
            leaf_count=max(6, int(6 + day * 0.45)),
            is_dark=is_dark,
            is_blur=is_blur
        )

        res = pipeline.process_image(
            img,
            plant_id="SLD-01",
            hst_day=day,
            timestamp=slot_ts,
            camera_id="ESP32-CAM-01"
        )
        print(f"HST Day {day:2d} [{slot_dt.strftime('%H:%M WIB')}]: Width {res['leaf_width_px']}px, Area {res['leaf_area_px']}px2 ({res['quality_status']})")

print("[Generator] Campaign dataset generation complete.")
