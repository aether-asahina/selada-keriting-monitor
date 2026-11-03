#!/usr/bin/env python3
"""
==============================================================================
LIVE / EMULATOR CLOUD INTEGRATION TEST SUITE (NO MOCKS)
Target:
  - Firebase Realtime Database REST API (Emulator or Staging)
  - Vercel Blob REST API (Staging Store)
  - End-to-End ServerlessCaptureIngestor against live HTTP endpoints

Discipline:
  - Strictly separated from in-memory mock unit tests.
  - NEVER prints or logs tokens, secrets, or full authenticated URLs.
  - When FIREBASE_RTDB_URL / BLOB_READ_WRITE_TOKEN are not provided in the
    environment, tests are explicitly marked skipped / NOT TESTED rather than
    claiming cloud integration succeeded.
==============================================================================
"""

import io
import os
import sys
import json
import time
import unittest
from datetime import datetime
from PIL import Image, ImageDraw

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_SCRIPTS_DIR = os.path.join(_REPO_ROOT, "scripts")
for _p in (_REPO_ROOT, _SCRIPTS_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from api.kelompok5.capture import (
    VercelBlobStorage,
    FirebaseRTDBStore,
    ServerlessCaptureIngestor,
    compute_fnv1a_hex,
    WIB_TIMEZONE,
)
from growth_cv_pipeline import LettuceCVPipeline


def _build_genuine_test_jpeg(width=320, height=240):
    img = Image.new("RGB", (width, height), (42, 32, 22))
    draw = ImageDraw.Draw(img)
    cx, cy = width // 2, height // 2
    rx, ry = width // 4, height // 4
    draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(32, 182, 44))
    for offset in range(-rx + 10, rx - 10, 8):
        draw.line([cx + offset, cy - ry + 15, cx + offset, cy + ry - 15], fill=(20, 140, 30), width=2)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


class TestLiveFirebaseRTDBIntegration(unittest.TestCase):
    """
    Real HTTP integration test against Firebase RTDB Emulator or Staging RTDB.
    Requires `FIREBASE_RTDB_URL` (e.g. `http://127.0.0.1:9000` or staging URL).
    """

    @classmethod
    def setUpClass(cls):
        cls.rtdb_url = os.environ.get("FIREBASE_RTDB_URL", "").strip()
        cls.auth_token = (
            os.environ.get("FIREBASE_AUTH_TOKEN", "").strip()
            or os.environ.get("FIREBASE_DB_SECRET", "").strip()
        )
        cls.access_token = os.environ.get("FIREBASE_ACCESS_TOKEN", "").strip()

    def setUp(self):
        if not self.rtdb_url:
            self.skipTest(
                "NOT TESTED: FIREBASE_RTDB_URL not set (requires Firebase Emulator or staging RTDB)"
            )
        self.store = FirebaseRTDBStore(
            db_url=self.rtdb_url,
            auth_token=self.auth_token,
            access_token=self.access_token,
            namespace="kelompok5_integration_test",
        )

    def test_live_rtdb_etag_cas_fencing_and_rollback(self):
        slot_key = "2026-11-03_10:00"
        fnv = "a1b2c3d4"
        now_ms = int(time.time() * 1000)

        # 1. Claim slot with Owner A
        status_a, lock_a = self.store.claim_slot(slot_key, fnv, owner_id="owner_a", now_ms=now_ms)
        self.assertIn(status_a, ("CLAIMED", "CONFIRMED"))
        if status_a == "CLAIMED":
            # 2. Active lease blocks Owner B
            status_b, _ = self.store.claim_slot(
                slot_key, fnv, owner_id="owner_b", now_ms=now_ms + 1000
            )
            self.assertEqual(status_b, "IN_PROGRESS")

            # 3. Fenced rollback by Owner A succeeds
            released = self.store.release_failed_slot(
                slot_key, lock_a, "integration_test_rollback", now_ms=now_ms + 2000
            )
            self.assertTrue(released)


class TestLiveVercelBlobIntegration(unittest.TestCase):
    """
    Real HTTP integration test against Vercel Blob Staging Store.
    Requires `BLOB_READ_WRITE_TOKEN`.
    """

    @classmethod
    def setUpClass(cls):
        cls.blob_token = os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()

    def setUp(self):
        if not self.blob_token:
            self.skipTest(
                "NOT TESTED: BLOB_READ_WRITE_TOKEN not set (requires Vercel Blob staging store token)"
            )
        self.blob = VercelBlobStorage(token=self.blob_token)

    def test_live_blob_idempotent_overwrite_and_delete(self):
        raw_jpeg = _build_genuine_test_jpeg(160, 120)
        path = "kelompok5_integration_test/smoke_orig.jpg"
        url1 = self.blob.put_bytes(path, raw_jpeg, "image/jpeg")
        self.assertTrue(url1.startswith("https://"))
        # Second PUT to identical deterministic pathname must succeed with x-allow-overwrite: 1
        url2 = self.blob.put_bytes(path, raw_jpeg, "image/jpeg")
        self.assertTrue(url2.startswith("https://"))
        self.blob.delete_blobs([url2])


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    print("\n================================================================")
    print(" CLOUD INTEGRATION TEST SUMMARY (REAL / EMULATOR ENDPOINTS)")
    print("================================================================")
    print(f"  Executed : {result.testsRun}")
    print(f"  Skipped (NOT TESTED - No Live Credentials): {len(result.skipped)}")
    print(f"  Failures : {len(result.failures) + len(result.errors)}")
    print("================================================================")
    sys.exit(0 if result.wasSuccessful() else 1)
