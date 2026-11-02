#!/usr/bin/env python3
"""
==============================================================================
AUTOMATED LETTUCE LEAF GROWTH COMPUTER VISION & SEGMENTATION PIPELINE
Species: Lactuca sativa L. var. crispa (Selada Keriting)
Stack: Python 3, NumPy, Pillow (Zero heavy C++ dependency)
Capabilities:
  - Illumination & Blur Quality Validation
  - Central ROI Crop
  - Excess Green Index (ExG = 2G - R - B) Vegetation Segmentation
  - Morphological Noise Elimination (Opening & Closing)
  - Maximum Leaf Width & Silhouette Area Extraction
  - Calibration Converter (Pixel to Millimeter)
  - Multi-artifact Generation (Original, Silhouette Mask, Contour Overlay)
==============================================================================
"""

import os
import sys
import json
import time
import math
from datetime import datetime, timezone, timedelta
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# ----------------------------------------------------------------------------
# Constants & Configuration
# ----------------------------------------------------------------------------
WIB_TIMEZONE = timezone(timedelta(hours=7)) # Asia/Jakarta UTC+7
CAMPAIGN_START_HST = 1
CAMPAIGN_END_HST = 42
TARGET_VALID_IMAGES = 1600
TOTAL_SLOTS_CAMPAIGN = 2520 # 60 slots/day * 42 days

# Image Quality Thresholds
MIN_BRIGHTNESS = 20.0   # Below this = true pitch-black / night / disconnected lens
MAX_BRIGHTNESS = 238.0  # Above this = overexposed / bleached
MIN_LAPLACIAN_VAR = 30.0 # Below this = heavily blurred / defocused

class LettuceCVPipeline:
    def __init__(self, output_dir="data/growth_images", meta_file="data/growth_metadata.json", calib_factor_mm_per_px=None):
        self.output_dir = output_dir
        self.meta_file = meta_file
        self.calib_factor = calib_factor_mm_per_px # None if uncalibrated
        self.algo_version = "v1.2-exg-otsu"

        os.makedirs(self.output_dir, exist_ok=True)
        os.makedirs(os.path.dirname(self.meta_file) if os.path.dirname(self.meta_file) else ".", exist_ok=True)
        if not os.path.exists(self.meta_file):
            with open(self.meta_file, "w") as f:
                json.dump([], f)

    def validate_quality(self, np_img):
        """
        Validates image illumination and sharpness.
        Returns: (is_valid, quality_status, detail_msg)
        """
        # 1. Illumination Check via luminance
        # Y = 0.299 R + 0.587 G + 0.114 B
        gray = 0.299 * np_img[:, :, 0] + 0.587 * np_img[:, :, 1] + 0.114 * np_img[:, :, 2]
        mean_lum = float(np.mean(gray))

        if mean_lum < MIN_BRIGHTNESS:
            return False, "INVALID_DARK", f"Pencahayaan redup ({mean_lum:.1f} < {MIN_BRIGHTNESS})"
        if mean_lum > MAX_BRIGHTNESS:
            return False, "INVALID_OVEREXPOSED", f"Pencahayaan berlebih ({mean_lum:.1f} > {MAX_BRIGHTNESS})"

        # 2. Laplacian Blur Detection (approximate 3x3 convolution)
        # Kernel: [[0, 1, 0], [1, -4, 1], [0, 1, 0]]
        padded = np.pad(gray, 1, mode='edge')
        laplacian = (
            padded[0:-2, 1:-1] +
            padded[2:, 1:-1] +
            padded[1:-1, 0:-2] +
            padded[1:-1, 2:] -
            4 * padded[1:-1, 1:-1]
        )
        lap_var = float(np.var(laplacian))

        if lap_var < MIN_LAPLACIAN_VAR:
            return False, "INVALID_BLUR", f"Gambar blur/tidak fokus (Laplacian var {lap_var:.1f} < {MIN_LAPLACIAN_VAR})"

        return True, "VALID", f"Kualitas baik (Luminansi {mean_lum:.1f}, Ketajaman {lap_var:.1f})"

    def segment_vegetation(self, np_img):
        """
        Computes Excess Green Index (ExG = 2G - R - B) and thresholds canopy.
        Returns binary mask (uint8: 255 for leaf, 0 for background).
        """
        r = np_img[:, :, 0].astype(np.float32)
        g = np_img[:, :, 1].astype(np.float32)
        b = np_img[:, :, 2].astype(np.float32)

        # Excess Green formula for Lactuca sativa
        exg = 2.0 * g - r - b

        # Adaptive / Otsu-like threshold selection on positive ExG pixels
        pos_exg = exg[exg > 0]
        if len(pos_exg) < 100:
            threshold = 15.0
        else:
            mean_val = np.mean(pos_exg)
            std_val = np.std(pos_exg)
            threshold = max(12.0, mean_val - 0.4 * std_val)

        # Initial raw mask
        raw_mask = (exg > threshold).astype(np.uint8) * 255

        # Morphological Opening (Remove small noise dots): 3x3 Min-filter then Max-filter
        cleaned = self._morph_open(raw_mask, kernel_size=3)
        # Morphological Closing (Bridge internal leaf veins): 5x5 Max-filter then Min-filter
        cleaned = self._morph_close(cleaned, kernel_size=5)

        return cleaned

    def _morph_open(self, binary_mask, kernel_size=3):
        img = Image.fromarray(binary_mask)
        eroded = img.filter(ImageFilter.MinFilter(kernel_size))
        opened = eroded.filter(ImageFilter.MaxFilter(kernel_size))
        return np.array(opened)

    def _morph_close(self, binary_mask, kernel_size=5):
        img = Image.fromarray(binary_mask)
        dilated = img.filter(ImageFilter.MaxFilter(kernel_size))
        closed = dilated.filter(ImageFilter.MinFilter(kernel_size))
        return np.array(closed)

    def extract_contour_and_measurements(self, mask):
        """
        Extracts leaf boundary coordinates, maximum horizontal width, and silhouette area.
        """
        # Silhouette area = count of positive pixels
        leaf_area_px = int(np.sum(mask > 0))

        if leaf_area_px < 50:
            return {
                "leaf_width_px": 0,
                "leaf_area_px": 0,
                "bbox": [0, 0, 0, 0],
                "contour_pts": []
            }

        # Bounding box of segmented leaf canopy
        y_indices, x_indices = np.where(mask > 0)
        x_min, x_max = int(np.min(x_indices)), int(np.max(x_indices))
        y_min, y_max = int(np.min(y_indices)), int(np.max(y_indices))

        leaf_width_px = int(x_max - x_min + 1)

        # Extract contour points (edges where pixel is 255 and has neighbor 0)
        padded = np.pad(mask > 0, 1, mode='constant', constant_values=False)
        is_edge = (mask > 0) & (
            (~padded[0:-2, 1:-1]) |
            (~padded[2:, 1:-1]) |
            (~padded[1:-1, 0:-2]) |
            (~padded[1:-1, 2:])
        )

        edge_y, edge_x = np.where(is_edge)
        # Sample contour points for clean JSON storage / overlay rendering
        step = max(1, len(edge_x) // 180)
        sampled_pts = [[int(edge_x[i]), int(edge_y[i])] for i in range(0, len(edge_x), step)]

        return {
            "leaf_width_px": leaf_width_px,
            "leaf_area_px": leaf_area_px,
            "bbox": [x_min, y_min, x_max, y_max],
            "contour_pts": sampled_pts
        }

    def generate_contour_overlay(self, pil_orig, mask, bbox, contour_pts):
        """
        Draws high-contrast neon cyan/green contour line and bounding box on original image.
        """
        overlay = pil_orig.copy().convert("RGBA")
        draw = ImageDraw.Draw(overlay)

        # Draw bounding box
        if bbox and (bbox[2] > bbox[0]):
            x0, y0, x1, y1 = bbox
            draw.rectangle([x0, y0, x1, y1], outline=(59, 130, 246, 200), width=2)
            draw.text((x0 + 4, max(4, y0 - 14)), f"Lebar: {x1 - x0}px", fill=(59, 130, 246, 240))

        # Draw contour boundary dots
        for pt in contour_pts:
            px, py = pt
            draw.ellipse([px - 1, py - 1, px + 1, py + 1], fill=(16, 185, 129, 230), outline=(16, 185, 129, 255))

        return overlay.convert("RGB")

    def process_image(self, input_image, plant_id="SLD-01", hst_day=1, timestamp=None, camera_id="ESP32-CAM-01"):
        """
        Full end-to-end processing execution.
        input_image: PIL.Image or path string.
        """
        if isinstance(input_image, str):
            pil_img = Image.open(input_image).convert("RGB")
        else:
            pil_img = input_image.convert("RGB")

        now_ts = timestamp if timestamp else int(time.time() * 1000)
        dt_wib = datetime.fromtimestamp(now_ts / 1000, tz=WIB_TIMEZONE)
        time_wib_str = dt_wib.strftime("%Y-%m-%d %H:%M:%S WIB")
        image_id = f"img_{dt_wib.strftime('%Y%m%d_%H%M%S')}"

        np_img = np.array(pil_img)

        # 1. Quality Check
        is_valid, quality_status, detail_msg = self.validate_quality(np_img)

        # 2. Central ROI Crop (10% border margin)
        h, w, _ = np_img.shape
        margin_y = int(h * 0.08)
        margin_x = int(w * 0.08)
        cropped_np = np_img[margin_y:h-margin_y, margin_x:w-margin_x]
        cropped_pil = Image.fromarray(cropped_np)

        # 3. ExG Vegetation Segmentation
        if is_valid:
            mask = self.segment_vegetation(cropped_np)
            measurements = self.extract_contour_and_measurements(mask)
            processing_status = "COMPLETED"
        else:
            # If invalid image, do NOT synthesize fake measurements
            mask = np.zeros((cropped_np.shape[0], cropped_np.shape[1]), dtype=np.uint8)
            measurements = {
                "leaf_width_px": 0,
                "leaf_area_px": 0,
                "bbox": [0, 0, 0, 0],
                "contour_pts": []
            }
            processing_status = "FAILED"

        # 4. Generate Visual Artifacts
        silhouette_pil = Image.fromarray(mask)
        overlay_pil = self.generate_contour_overlay(
            cropped_pil, mask, measurements["bbox"], measurements["contour_pts"]
        )

        # 5. File Persistence
        orig_rel_path = f"{self.output_dir}/{image_id}_orig.jpg"
        mask_rel_path = f"{self.output_dir}/{image_id}_mask.png"
        overlay_rel_path = f"{self.output_dir}/{image_id}_overlay.jpg"

        cropped_pil.save(orig_rel_path, format="JPEG", quality=88)
        silhouette_pil.save(mask_rel_path, format="PNG")
        overlay_pil.save(overlay_rel_path, format="JPEG", quality=88)

        # 6. Physical Calibration Translation
        leaf_width_mm = None
        leaf_area_mm2 = None
        if self.calib_factor and is_valid and measurements["leaf_width_px"] > 0:
            leaf_width_mm = round(measurements["leaf_width_px"] * self.calib_factor, 2)
            leaf_area_mm2 = round(measurements["leaf_area_px"] * (self.calib_factor ** 2), 2)

        record = {
            "kelompok": "Kelompok 5",
            "image_id": image_id,
            "plant_id": plant_id,
            "captured_at": now_ts,
            "time_wib": time_wib_str,
            "hst_day": hst_day,
            "leaf_width_px": measurements["leaf_width_px"],
            "leaf_width_mm": leaf_width_mm,
            "leaf_area_px": measurements["leaf_area_px"],
            "leaf_area_mm2": leaf_area_mm2,
            "quality_status": quality_status,
            "quality_detail": detail_msg,
            "processing_status": processing_status,
            "camera_id": camera_id,
            "algorithm_version": self.algo_version,
            "image_url": orig_rel_path,
            "mask_url": mask_rel_path,
            "overlay_url": overlay_rel_path
        }

        self._append_metadata(record)
        return record

    def _append_metadata(self, record):
        try:
            records = []
            if os.path.exists(self.meta_file):
                with open(self.meta_file, "r") as f:
                    records = json.load(f)
            records.append(record)
            with open(self.meta_file, "w") as f:
                json.dump(records, f, indent=2)
        except Exception as e:
            print(f"[LettuceCVPipeline] Failed to append metadata: {e}", file=sys.stderr)

if __name__ == "__main__":
    print(f"[LettuceCVPipeline] Initializing Computer Vision Engine (Algo: v1.2-exg-otsu)...")
    pipeline = LettuceCVPipeline()

    if len(sys.argv) > 1 and sys.argv[1] not in ("--help", "-h"):
        img_path = sys.argv[1]
        plant_id = sys.argv[2] if len(sys.argv) > 2 else "SLD-01"
        hst = int(sys.argv[3]) if len(sys.argv) > 3 else 1

        if os.path.exists(img_path):
            print(f"[LettuceCVPipeline] Processing genuine captured image: {img_path}")
            res = pipeline.process_image(img_path, plant_id=plant_id, hst_day=hst)
            print(f"[LettuceCVPipeline] Result:")
            print(f"  - Image ID       : {res['image_id']}")
            print(f"  - Leaf Width     : {res['leaf_width_px']} px")
            print(f"  - Leaf Area      : {res['leaf_area_px']} px²")
            print(f"  - Quality Status : {res['quality_status']} ({res['quality_detail']})")
            print(f"  - Original Saved : {res['image_url']}")
            print(f"  - Mask Saved     : {res['mask_url']}")
            print(f"  - Overlay Saved  : {res['overlay_url']}")
        else:
            print(f"[LettuceCVPipeline] Error: Image file not found: {img_path}", file=sys.stderr)
            sys.exit(1)
    else:
        print("[LettuceCVPipeline] Pipeline Engine Ready (100% Real Data Mode - Zero Synthetic Generation).")
        print("Usage: python3 scripts/growth_cv_pipeline.py <path_to_genuine_image.jpg> [plant_id] [hst_day]")
        print("Scheduled automated captures are executed via scripts/scheduler_daemon.py.")

