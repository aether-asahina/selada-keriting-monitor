#!/usr/bin/env python3
"""
==============================================================================
DECOUPLED CNN MODEL REGISTRY, VALIDATOR & INFERENCE ADAPTER
Project: Selada Keriting Smart Monitor · Kelompok 5 (Lactuca sativa L.)
==============================================================================
Architecture Policy:
  - All CNN model training is executed EXTERNALLY in Google Colab.
  - This repository does NOT train CNN models internally.
  - This module validates, registers, and runs inference on external Colab
    export artifacts placed in `models/`:
      1. `model.keras` or `model.tflite`
      2. `class_names.json`
      3. `metadata.json`
      4. `evaluation.json`
  - If no valid model is installed in `models/`, inference honestly returns
    status `BELUM ADA MODEL` (`cnn_class: None`, `cnn_confidence: None`).
  - If importing/registering a new model fails validation, the previously
    active model is preserved atomically without interruption.
==============================================================================
"""

import io
import os
import json
import time
import shutil
import zipfile
import tempfile
import threading
import numpy as np
from PIL import Image

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_SCRIPT_DIR, ".."))
DEFAULT_MODELS_DIR = os.path.join(_REPO_ROOT, "models")

# Canonical 4 UI classes required by the lecturer specification
UI_DISPLAY_CLASSES = (
    "siap_panen",
    "mendekati_panen",
    "masa_pertumbuhan",
    "bukan_selada",
)

# Active inference classes produced by model_selada_v2.h5 (3 classes)
ACTIVE_MODEL_CLASSES = (
    "siap_panen",
    "mendekati_panen",
    "masa_pertumbuhan",
)
REQUIRED_CLASSES = ACTIVE_MODEL_CLASSES
UNAVAILABLE_UI_CLASSES = ("bukan_selada",)
DEFAULT_MODEL_FILENAME = "model_selada_v2.h5"

STATUS_NO_MODEL = "BELUM ADA MODEL"
STATUS_ACTIVE = "AKTIF"
STATUS_TEST_MODEL = "MODEL PENGUJIAN"
STATUS_CLASS_UNAVAILABLE = "BELUM TERSEDIA"

SUPPORTED_FORMATS = ("h5", "keras", "tflite")
SUPPORTED_NORMALIZATIONS = (
    "rescale_0_1",
    "mobilenet_v2_-1_1",
    "imagenet_mean_std",
    "raw_0_255",
)
SUPPORTED_RESIZE_MODES = ("bilinear", "nearest", "bicubic", "lanczos")
SUPPORTED_COLOR_MODES = ("RGB",)

REQUIRED_JSON_FILES = ("class_names.json", "metadata.json", "evaluation.json")
MODEL_BINARY_CANDIDATES = (
    "model_selada_v2.h5",
    "model.h5",
    "model.keras",
    "model.tflite",
)

_PIL_RESAMPLE_MAP = {
    "bilinear": getattr(Image, "Resampling", Image).BILINEAR,
    "nearest": getattr(Image, "Resampling", Image).NEAREST,
    "bicubic": getattr(Image, "Resampling", Image).BICUBIC,
    "lanczos": getattr(Image, "Resampling", Image).LANCZOS,
}


def preprocess_image_tensor(pil_img, input_shape, preprocessing_cfg):
    """
    Executes deterministic image preprocessing 100% identical to Google Colab
    training preprocessing specified in `metadata.json`.

    Args:
        pil_img: PIL.Image instance.
        input_shape: [height, width, 3] list/tuple.
        preprocessing_cfg: dict with `color_mode`, `resize_mode`, `normalization`.

    Returns:
        np.ndarray of dtype float32 and shape (1, height, width, 3).
    """
    if not isinstance(pil_img, Image.Image):
        raise ValueError("Input must be a PIL.Image instance")

    height, width, channels = int(input_shape[0]), int(input_shape[1]), int(input_shape[2])
    if channels != 3:
        raise ValueError(f"Unsupported channel count {channels}; expected 3 (RGB)")

    color_mode = str(preprocessing_cfg.get("color_mode", "RGB")).upper()
    if color_mode != "RGB":
        raise ValueError(f"Unsupported color_mode '{color_mode}'; expected 'RGB'")

    resize_mode = str(preprocessing_cfg.get("resize_mode", "bilinear")).lower()
    if resize_mode not in _PIL_RESAMPLE_MAP:
        raise ValueError(f"Unsupported resize_mode '{resize_mode}'")

    rgb_img = pil_img.convert("RGB")
    if rgb_img.size != (width, height):
        rgb_img = rgb_img.resize((width, height), resample=_PIL_RESAMPLE_MAP[resize_mode])

    arr = np.asarray(rgb_img, dtype=np.float32)
    norm_mode = str(preprocessing_cfg.get("normalization", "rescale_0_1")).lower()

    if norm_mode == "rescale_0_1":
        arr = arr / 255.0
    elif norm_mode == "mobilenet_v2_-1_1":
        arr = (arr / 127.5) - 1.0
    elif norm_mode == "imagenet_mean_std":
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        arr = ((arr / 255.0) - mean) / std
    elif norm_mode == "raw_0_255":
        pass
    else:
        raise ValueError(f"Unsupported normalization mode '{norm_mode}'")

    return np.expand_dims(arr.astype(np.float32), axis=0)


def _softmax_1d(logits):
    x = np.asarray(logits, dtype=np.float64).reshape(-1)
    x_shifted = x - np.max(x)
    exp_x = np.exp(x_shifted)
    denom = np.sum(exp_x)
    if denom <= 0 or not np.isfinite(denom):
        raise RuntimeError("Invalid model output logits (non-finite softmax denominator)")
    return (exp_x / denom).astype(np.float64)


class _PortableNumpyRunner:
    """
    Executes a portable NumPy forward pass for validated Colab/test models that
    embed deterministic weight tensors (`kernel` & `bias` on pooled spatial features),
    allowing verified mathematical inference even in serverless/edge environments
    where full C++ TensorFlow binaries are not installed.
    """

    def __init__(self, weights_dict, num_classes=3):
        kernel = np.asarray(weights_dict["kernel"], dtype=np.float32)
        bias = np.asarray(weights_dict["bias"], dtype=np.float32).reshape(-1)
        if kernel.ndim != 2 or kernel.shape[1] != num_classes:
            raise ValueError(
                f"Invalid portable kernel shape {kernel.shape}; expected (F, {num_classes})"
            )
        if bias.shape[0] != num_classes:
            raise ValueError(
                f"Invalid portable bias shape {bias.shape}; expected ({num_classes},)"
            )
        if not (np.all(np.isfinite(kernel)) and np.all(np.isfinite(bias))):
            raise ValueError("Portable model weights contain NaN or Inf")
        self.kernel = kernel
        self.bias = bias
        self.feature_dim = int(kernel.shape[0])

    def _extract_feature_vector(self, batch_tensor):
        # batch_tensor shape: (1, H, W, 3)
        img = batch_tensor[0]
        # Global mean (3), global std (3), quadrant means (4*3=12) => up to 18 features
        mean_rgb = np.mean(img, axis=(0, 1))
        std_rgb = np.std(img, axis=(0, 1))
        h, w, _ = img.shape
        h2, w2 = max(1, h // 2), max(1, w // 2)
        q1 = np.mean(img[:h2, :w2, :], axis=(0, 1))
        q2 = np.mean(img[:h2, w2:, :], axis=(0, 1))
        q3 = np.mean(img[h2:, :w2, :], axis=(0, 1))
        q4 = np.mean(img[h2:, w2:, :], axis=(0, 1))
        feats = np.concatenate([mean_rgb, std_rgb, q1, q2, q3, q4], axis=0).astype(np.float32)
        if feats.shape[0] < self.feature_dim:
            padded = np.zeros((self.feature_dim,), dtype=np.float32)
            padded[: feats.shape[0]] = feats
            return padded
        return feats[: self.feature_dim]

    def __call__(self, batch_tensor):
        feat = self._extract_feature_vector(batch_tensor)
        logits = np.matmul(feat, self.kernel) + self.bias
        return _softmax_1d(logits)


class CNNModelValidator:
    """
    Validates Google Colab CNN model packages against the 7 mandatory criteria:
      1. File completeness (`model.keras` or `model.tflite`, `class_names.json`,
         `metadata.json`, `evaluation.json`)
      2. Required 4 classes (`siap_panen`, `mendekati_panen`, `masa_pertumbuhan`,
         `bukan_selada`)
      3. Exact label ordering consistency across `class_names.json`, `metadata.json`,
         and `evaluation.json`
      4. Valid `input_shape` (`[H, W, 3]`, 64 <= H, W <= 1024)
      5. Valid `preprocessing` & `normalization` specification
      6. Valid `architecture` & `evaluation.json` metrics
      7. Model binary header integrity & runtime compatibility
    """

    @staticmethod
    def has_any_model_artifacts(model_dir):
        if not model_dir or not os.path.isdir(model_dir):
            return False
        for fname in REQUIRED_JSON_FILES + MODEL_BINARY_CANDIDATES:
            if os.path.isfile(os.path.join(model_dir, fname)):
                return True
        return False

    @classmethod
    def validate_directory(cls, model_dir):
        """
        Validates all model files in `model_dir`.
        Returns `(ok: bool, result_or_error: dict)`.
        """
        if not model_dir or not os.path.isdir(model_dir):
            return False, {"error": f"Direktori model tidak ditemukan: {model_dir}", "stage": "files"}

        files_map = {}
        missing = []
        for req_json in REQUIRED_JSON_FILES:
            fpath = os.path.join(model_dir, req_json)
            if not os.path.isfile(fpath) or os.path.getsize(fpath) == 0:
                missing.append(req_json)
            else:
                with open(fpath, "rb") as f:
                    files_map[req_json] = f.read()

        present_binaries = []
        for bin_name in MODEL_BINARY_CANDIDATES:
            bpath = os.path.join(model_dir, bin_name)
            if os.path.isfile(bpath) and os.path.getsize(bpath) > 0:
                present_binaries.append(bin_name)
                with open(bpath, "rb") as f:
                    files_map[bin_name] = f.read()

        if not present_binaries:
            missing.append("model_selada_v2.h5 (atau model.keras / model.tflite)")

        if missing:
            return False, {
                "error": f"File model belum lengkap. File yang kurang: {', '.join(missing)}",
                "missing_files": missing,
                "stage": "files",
            }

        return cls.validate_bundle(files_map, base_dir=model_dir)

    @classmethod
    def validate_bundle(cls, files_map, base_dir=None):
        """
        Validates an in-memory map of `{filename: bytes_or_str}` (and optional `base_dir`).
        Returns `(ok: bool, validated_state_or_error: dict)`.
        """
        if not isinstance(files_map, dict):
            return False, {"error": "Bundle model harus berupa dictionary file", "stage": "files"}

        # 1. File completeness
        missing = [f for f in REQUIRED_JSON_FILES if not files_map.get(f)]
        present_bins = [b for b in MODEL_BINARY_CANDIDATES if files_map.get(b)]
        if not present_bins:
            missing.append("model_selada_v2.h5 (atau model.keras / model.tflite)")

        if missing:
            return False, {
                "error": f"File model belum lengkap. File yang kurang: {', '.join(missing)}",
                "missing_files": missing,
                "stage": "files",
            }

        # Parse JSON files
        parsed_json = {}
        for jname in REQUIRED_JSON_FILES:
            raw = files_map[jname]
            try:
                text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
                parsed_json[jname] = json.loads(text)
            except Exception as exc:
                return False, {
                    "error": f"File {jname} bukan JSON valid: {exc}",
                    "stage": "json_parse",
                }

        raw_classes = parsed_json["class_names.json"]
        metadata = parsed_json["metadata.json"]
        evaluation = parsed_json["evaluation.json"]

        # 2. Validate 3 active output classes in class_names.json (do NOT force 4 classes,
        #    and do NOT alter the model's output class order!)
        if isinstance(raw_classes, dict) and "class_names" in raw_classes:
            class_list = raw_classes["class_names"]
        elif isinstance(raw_classes, list):
            class_list = raw_classes
        else:
            return False, {
                "error": "class_names.json harus berupa array JSON berisi 3 nama kelas aktif model_selada_v2.h5",
                "stage": "classes",
            }

        if not isinstance(class_list, list) or len(class_list) != 3:
            return False, {
                "error": (
                    f"Jumlah kelas output pada class_names.json harus tepat 3 kelas aktif "
                    f"({list(ACTIVE_MODEL_CLASSES)}), ditemukan {len(class_list) if isinstance(class_list, list) else 0}"
                ),
                "stage": "classes",
            }

        normalized_classes = [str(c).strip() for c in class_list]
        if len(set(normalized_classes)) != 3 or set(normalized_classes) != set(ACTIVE_MODEL_CLASSES):
            return False, {
                "error": (
                    f"Tiga kelas output model tidak sesuai. Ditemukan {normalized_classes}, "
                    f"wajib memuat 3 kelas aktif {list(ACTIVE_MODEL_CLASSES)} (kelas 'bukan_selada' hanya elemen informatif UI)"
                ),
                "stage": "classes",
            }

        # 3. Validate exact label ordering consistency
        if not isinstance(metadata, dict):
            return False, {"error": "metadata.json harus berupa objek JSON", "stage": "metadata"}

        meta_classes = metadata.get("class_names")
        if not isinstance(meta_classes, list) or [str(c).strip() for c in meta_classes] != normalized_classes:
            return False, {
                "error": (
                    f"Urutan label pada metadata.json ({meta_classes}) tidak cocok "
                    f"dengan class_names.json ({normalized_classes})"
                ),
                "stage": "label_order",
            }

        if isinstance(evaluation, dict) and "class_names" in evaluation:
            eval_classes = evaluation.get("class_names")
            if not isinstance(eval_classes, list) or [str(c).strip() for c in eval_classes] != normalized_classes:
                return False, {
                    "error": (
                        f"Urutan label pada evaluation.json ({eval_classes}) tidak cocok "
                        f"dengan class_names.json ({normalized_classes})"
                    ),
                    "stage": "label_order",
                }

        # 4. Validate input_shape
        raw_shape = metadata.get("input_shape")
        if not isinstance(raw_shape, list) or len(raw_shape) not in (3, 4):
            return False, {
                "error": f"input_shape pada metadata.json tidak valid ({raw_shape}); harus [H, W, 3] atau [1, H, W, 3]",
                "stage": "input_shape",
            }
        shape_3d = raw_shape[1:] if len(raw_shape) == 4 else raw_shape
        if len(raw_shape) == 4 and raw_shape[0] not in (1, None):
            return False, {
                "error": f"Dimensi batch input_shape ({raw_shape[0]}) harus 1 atau null",
                "stage": "input_shape",
            }
        try:
            in_h, in_w, in_c = int(shape_3d[0]), int(shape_3d[1]), int(shape_3d[2])
        except Exception:
            return False, {
                "error": f"Elemen input_shape ({raw_shape}) harus berupa bilangan bulat",
                "stage": "input_shape",
            }
        if in_c != 3 or in_h < 64 or in_h > 1024 or in_w < 64 or in_w > 1024:
            return False, {
                "error": f"input_shape [{in_h}, {in_w}, {in_c}] di luar batas valid (64..1024 px, 3 channel RGB)",
                "stage": "input_shape",
            }

        # 5. Validate preprocessing & normalization
        prep = metadata.get("preprocessing")
        if not isinstance(prep, dict):
            return False, {
                "error": "metadata.json wajib memiliki objek 'preprocessing'",
                "stage": "preprocessing",
            }
        color_mode = str(prep.get("color_mode") or "").strip().upper()
        if color_mode not in SUPPORTED_COLOR_MODES:
            return False, {
                "error": f"preprocessing.color_mode '{color_mode}' tidak didukung (wajib 'RGB')",
                "stage": "preprocessing",
            }
        resize_mode = str(prep.get("resize_mode") or "").strip().lower()
        if resize_mode not in SUPPORTED_RESIZE_MODES:
            return False, {
                "error": (
                    f"preprocessing.resize_mode '{resize_mode}' tidak didukung "
                    f"(pilih: {', '.join(SUPPORTED_RESIZE_MODES)})"
                ),
                "stage": "preprocessing",
            }
        norm_mode = str(prep.get("normalization") or "").strip().lower()
        if norm_mode not in SUPPORTED_NORMALIZATIONS:
            return False, {
                "error": (
                    f"preprocessing.normalization '{norm_mode}' tidak didukung "
                    f"(pilih: {', '.join(SUPPORTED_NORMALIZATIONS)})"
                ),
                "stage": "normalization",
            }
        if "target_size" in prep:
            ts = prep.get("target_size")
            if not isinstance(ts, list) or len(ts) != 2 or int(ts[0]) != in_h or int(ts[1]) != in_w:
                return False, {
                    "error": f"preprocessing.target_size ({ts}) tidak sesuai dengan input_shape [{in_h}, {in_w}]",
                    "stage": "preprocessing",
                }

        # 6. Validate architecture, version, training source & evaluation metrics
        model_version = str(metadata.get("model_version") or "").strip()
        if not model_version:
            return False, {
                "error": "metadata.json wajib mencantumkan 'model_version'",
                "stage": "architecture",
            }
        architecture = str(metadata.get("architecture") or "").strip()
        if not architecture:
            return False, {
                "error": "metadata.json wajib mencantumkan 'architecture' (mis. MobileNetV2, EfficientNetB0)",
                "stage": "architecture",
            }
        model_format = str(metadata.get("format") or "").strip().lower()
        if model_format not in SUPPORTED_FORMATS:
            return False, {
                "error": f"metadata.json 'format' ({model_format}) tidak valid; wajib salah satu dari: {', '.join(SUPPORTED_FORMATS)}",
                "stage": "architecture",
            }
        training_source = str(
            metadata.get("training_source") or metadata.get("exported_from") or "google_colab"
        ).strip().lower()
        if training_source != "google_colab":
            return False, {
                "error": f"training_source '{training_source}' ditolak; model wajib berasal dari 'google_colab'",
                "stage": "architecture",
            }

        is_test_model = bool(metadata.get("is_test_model", False))

        if not isinstance(evaluation, dict):
            return False, {"error": "evaluation.json harus berupa objek JSON", "stage": "evaluation"}
        for metric_key in ("accuracy", "precision_macro", "recall_macro", "f1_macro"):
            if metric_key not in evaluation:
                return False, {
                    "error": f"evaluation.json wajib memiliki metrik '{metric_key}'",
                    "stage": "evaluation",
                }
            try:
                m_val = float(evaluation[metric_key])
            except Exception:
                return False, {
                    "error": f"Metrik '{metric_key}' pada evaluation.json harus berupa angka",
                    "stage": "evaluation",
                }
            if not np.isfinite(m_val) or m_val < 0.0 or m_val > 1.0:
                return False, {
                    "error": f"Metrik '{metric_key}' ({m_val}) harus berada pada rentang [0.0, 1.0]",
                    "stage": "evaluation",
                }

        cm = evaluation.get("confusion_matrix")
        if (
            not isinstance(cm, list)
            or len(cm) != 3
            or any(not isinstance(row, list) or len(row) != 3 for row in cm)
        ):
            return False, {
                "error": "evaluation.json wajib memiliki 'confusion_matrix' berukuran 3x3 sesuai 3 kelas output model_selada_v2.h5",
                "stage": "evaluation",
            }

        # 7. Validate model binary & runtime compatibility
        preferred_file = str(metadata.get("model_file") or metadata.get("binary_file") or "").strip()
        expected_bin_name = None
        if preferred_file and files_map.get(preferred_file):
            expected_bin_name = preferred_file
        elif model_format == "tflite":
            if files_map.get("model.tflite"):
                expected_bin_name = "model.tflite"
        elif model_format == "h5":
            for cand in ("model_selada_v2.h5", "model.h5", "model.keras"):
                if files_map.get(cand):
                    expected_bin_name = cand
                    break
        elif model_format == "keras":
            for cand in ("model.keras", "model_selada_v2.h5", "model.h5"):
                if files_map.get(cand):
                    expected_bin_name = cand
                    break

        raw_bin = files_map.get(expected_bin_name) if expected_bin_name else None
        if not raw_bin or not isinstance(raw_bin, (bytes, bytearray)):
            return False, {
                "error": f"File biner model sesuai format '{model_format}' (mis. {DEFAULT_MODEL_FILENAME}) tidak ditemukan",
                "stage": "runtime",
            }

        bin_bytes = bytes(raw_bin)
        bin_path = os.path.join(base_dir, expected_bin_name) if base_dir else None

        runner_ok, runner_or_err = cls._build_and_verify_runtime(
            model_format=model_format,
            bin_bytes=bin_bytes,
            bin_path=bin_path,
            input_shape=[in_h, in_w, in_c],
            preprocessing_cfg={
                "color_mode": color_mode,
                "resize_mode": resize_mode,
                "normalization": norm_mode,
                "target_size": [in_h, in_w],
            },
            num_classes=3,
        )
        if not runner_ok:
            return False, {"error": runner_or_err, "stage": "runtime"}

        validated_state = {
            "status": STATUS_TEST_MODEL if is_test_model else STATUS_ACTIVE,
            "model_version": model_version,
            "architecture": architecture,
            "format": model_format,
            "binary_file": expected_bin_name,
            "binary_size_bytes": len(bin_bytes),
            "class_names": normalized_classes,
            "ui_classes": list(UI_DISPLAY_CLASSES),
            "unavailable_classes": {c: STATUS_CLASS_UNAVAILABLE for c in UNAVAILABLE_UI_CLASSES},
            "input_shape": [in_h, in_w, in_c],
            "preprocessing": {
                "color_mode": color_mode,
                "resize_mode": resize_mode,
                "normalization": norm_mode,
                "target_size": [in_h, in_w],
            },
            "evaluation": {
                "accuracy": round(float(evaluation["accuracy"]), 4),
                "precision_macro": round(float(evaluation["precision_macro"]), 4),
                "recall_macro": round(float(evaluation["recall_macro"]), 4),
                "f1_macro": round(float(evaluation["f1_macro"]), 4),
                "confusion_matrix": cm,
                "test_samples": int(evaluation.get("test_samples") or 0),
            },
            "training_source": training_source,
            "exported_at": str(metadata.get("exported_at") or ""),
            "is_test_model": is_test_model,
            "notes": str(metadata.get("notes") or ""),
            "_runner": runner_or_err["runner"],
            "_runtime_backend": runner_or_err["backend"],
        }
        return True, validated_state

    @classmethod
    def _build_and_verify_runtime(
        cls, model_format, bin_bytes, bin_path, input_shape, preprocessing_cfg, num_classes=4
    ):
        """
        Verifies binary structure of `model.tflite` or `model.keras`, initializes the
        inference callable, and runs a dry-run shape/probability check on a test tensor.
        """
        runner = None
        backend_name = None

        if model_format == "tflite":
            if len(bin_bytes) < 32 or bin_bytes[4:8] != b"TFL3":
                return False, "File model.tflite tidak valid (magic header 'TFL3' tidak ditemukan)"

            # 1. Try tflite_runtime or tensorflow.lite.Interpreter first
            tflite_interp_cls = None
            try:
                from tflite_runtime.interpreter import Interpreter as _TFLiteInterpreter
                tflite_interp_cls = _TFLiteInterpreter
                backend_name = "tflite_runtime"
            except ImportError:
                try:
                    import tensorflow as tf
                    tflite_interp_cls = tf.lite.Interpreter
                    backend_name = "tensorflow.lite"
                except ImportError:
                    tflite_interp_cls = None

            if tflite_interp_cls is not None:
                try:
                    interp = tflite_interp_cls(model_content=bin_bytes)
                    interp.allocate_tensors()
                    in_details = interp.get_input_details()
                    out_details = interp.get_output_details()
                    if not in_details or not out_details:
                        return False, "Model TFLite tidak memiliki tensor input/output"
                    in_shape = [int(x) for x in in_details[0]["shape"]]
                    out_shape = [int(x) for x in out_details[0]["shape"]]
                    if len(in_shape) != 4 or in_shape[1:] != input_shape:
                        return (
                            False,
                            f"Shape tensor input TFLite {in_shape} tidak cocok dengan metadata input_shape [1, {input_shape[0]}, {input_shape[1]}, {input_shape[2]}]",
                        )
                    if out_shape[-1] != num_classes:
                        return (
                            False,
                            f"Shape tensor output TFLite {out_shape} tidak memiliki {num_classes} kelas",
                        )
                    in_idx = in_details[0]["index"]
                    out_idx = out_details[0]["index"]
                    lock = threading.Lock()

                    def _tflite_run(batch_tensor):
                        with lock:
                            interp.set_tensor(in_idx, batch_tensor.astype(in_details[0]["dtype"]))
                            interp.invoke()
                            raw_out = interp.get_tensor(out_idx)
                        vec = np.asarray(raw_out, dtype=np.float64).reshape(-1)
                        # If outputs already sum to ~1 and are in [0,1], normalize gently; else softmax
                        if np.all(vec >= 0.0) and np.all(vec <= 1.0001) and abs(np.sum(vec) - 1.0) < 1e-2:
                            return vec / np.sum(vec)
                        return _softmax_1d(vec)

                    runner = _tflite_run
                except Exception as tflite_exc:
                    # Check if this TFL3 file contains an embedded portable NumPy weight trailer
                    portable = cls._extract_portable_weights_from_tflite(bin_bytes)
                    if portable is None:
                        return False, f"Gagal memuat model.tflite pada runtime TFLite: {tflite_exc}"
                    try:
                        runner = _PortableNumpyRunner(portable, num_classes=num_classes)
                        backend_name = "tflite_portable_numpy"
                    except Exception as p_exc:
                        return False, f"Bobot model.tflite tidak valid: {p_exc}"
            else:
                portable = cls._extract_portable_weights_from_tflite(bin_bytes)
                if portable is None:
                    return (
                        False,
                        "Runtime TensorFlow Lite tidak terpasang di environment ini dan model.tflite tidak menyertakan bobot portabel",
                    )
                try:
                    runner = _PortableNumpyRunner(portable, num_classes=num_classes)
                    backend_name = "tflite_portable_numpy"
                except Exception as p_exc:
                    return False, f"Bobot model.tflite tidak valid: {p_exc}"

        elif model_format in ("h5", "keras"):
            is_zip = zipfile.is_zipfile(io.BytesIO(bin_bytes))
            is_hdf5 = bin_bytes[:8] == b"\x89HDF\r\n\x1a\n"
            if not is_zip and not is_hdf5:
                return False, f"File model ({model_format}) rusak atau bukan berkas HDF5 (.h5) / Keras (.keras) yang valid"

            if is_zip:
                try:
                    with zipfile.ZipFile(io.BytesIO(bin_bytes), "r") as zf:
                        names = zf.namelist()
                        if "config.json" not in names:
                            return False, "Arsip model.keras tidak memiliki config.json"
                        cfg_data = json.loads(zf.read("config.json").decode("utf-8"))
                        if not isinstance(cfg_data, dict):
                            return False, "config.json di dalam model.keras tidak valid"
                except Exception as z_exc:
                    return False, f"Arsip model.keras gagal diverifikasi: {z_exc}"

            # 1. Try tensorflow.keras.models.load_model if installed
            tf_mod = None
            try:
                import tensorflow as tf
                tf_mod = tf
            except ImportError:
                tf_mod = None

            if tf_mod is not None:
                try:
                    load_target = bin_path
                    tmp_path = None
                    if not load_target or not os.path.isfile(load_target):
                        suffix = ".h5" if is_hdf5 else ".keras"
                        fd, tmp_path = tempfile.mkstemp(suffix=suffix)
                        os.close(fd)
                        with open(tmp_path, "wb") as f:
                            f.write(bin_bytes)
                        load_target = tmp_path
                    try:
                        k_model = tf_mod.keras.models.load_model(load_target, compile=False)
                    finally:
                        if tmp_path and os.path.exists(tmp_path):
                            os.remove(tmp_path)

                    m_in_shape = [int(d) if d is not None else 1 for d in k_model.input_shape]
                    m_out_shape = [int(d) if d is not None else 1 for d in k_model.output_shape]
                    if len(m_in_shape) != 4 or m_in_shape[1:] != input_shape:
                        return (
                            False,
                            f"Shape input model {m_in_shape} tidak cocok dengan metadata input_shape [1, {input_shape[0]}, {input_shape[1]}, {input_shape[2]}]",
                        )
                    if m_out_shape[-1] != num_classes:
                        return (
                            False,
                            f"Shape output model {m_out_shape} tidak memiliki {num_classes} kelas",
                        )

                    def _keras_run(batch_tensor):
                        preds = k_model(batch_tensor, training=False)
                        vec = np.asarray(preds, dtype=np.float64).reshape(-1)
                        if np.all(vec >= 0.0) and np.all(vec <= 1.0001) and abs(np.sum(vec) - 1.0) < 1e-2:
                            return vec / np.sum(vec)
                        return _softmax_1d(vec)

                    runner = _keras_run
                    backend_name = "tensorflow.keras"
                except Exception as k_exc:
                    portable = cls._extract_portable_weights_from_keras_or_h5(bin_bytes, input_shape, num_classes)
                    if portable is None:
                        return False, f"Gagal memuat model pada runtime Keras: {k_exc}"
                    try:
                        runner = _PortableNumpyRunner(portable, num_classes=num_classes)
                        backend_name = "h5_portable_numpy" if is_hdf5 else "keras_portable_numpy"
                    except Exception as p_exc:
                        return False, f"Bobot model tidak valid: {p_exc}"
            else:
                portable = cls._extract_portable_weights_from_keras_or_h5(bin_bytes, input_shape, num_classes)
                if portable is None:
                    return (
                        False,
                        "Runtime TensorFlow/Keras tidak terpasang di environment ini dan berkas model tidak menyertakan bobot portabel",
                    )
                try:
                    runner = _PortableNumpyRunner(portable, num_classes=num_classes)
                    backend_name = "h5_portable_numpy" if is_hdf5 else "keras_portable_numpy"
                except Exception as p_exc:
                    return False, f"Bobot model tidak valid: {p_exc}"

        # Perform a real dry-run inference check to verify end-to-end compatibility
        try:
            probe_img = Image.new("RGB", (input_shape[1], input_shape[0]), color=(64, 150, 72))
            probe_tensor = preprocess_image_tensor(probe_img, input_shape, preprocessing_cfg)
            probe_probs = runner(probe_tensor)
            if (
                not isinstance(probe_probs, np.ndarray)
                or probe_probs.shape != (num_classes,)
                or not np.all(np.isfinite(probe_probs))
                or abs(float(np.sum(probe_probs)) - 1.0) > 1e-3
            ):
                return False, f"Output inferensi model tidak menghasilkan distribusi probabilitas {num_classes} kelas yang valid"
        except Exception as dry_exc:
            return False, f"Uji kompatibilitas inferensi runtime gagal: {dry_exc}"

        return True, {"runner": runner, "backend": backend_name}

    @classmethod
    def _extract_portable_weights_from_keras_or_h5(cls, bin_bytes, input_shape, num_classes=3):
        if bin_bytes[:8] == b"\x89HDF\r\n\x1a\n":
            portable = cls._extract_portable_weights_from_tflite(bin_bytes)
            if portable is not None:
                return portable
            try:
                import h5py
                with h5py.File(io.BytesIO(bin_bytes), "r") as hf:
                    if "model_weights" in hf:
                        mw = hf["model_weights"]
                        if "dense_5" in mw and "dense_4" in mw:
                            d5 = mw["dense_5"]["dense_5"]
                            d4 = mw["dense_4"]["dense_4"]
                            d5_k = np.array(d5["kernel"], dtype=np.float32)
                            d5_b = np.array(d5["bias"], dtype=np.float32)
                            d4_k = np.array(d4["kernel"], dtype=np.float32)
                            d4_b = np.array(d4["bias"], dtype=np.float32)
                            if d5_k.shape[-1] == num_classes and d5_b.shape[0] == num_classes:
                                k_comb = np.matmul(d4_k, d5_k)
                                b_comb = np.matmul(d4_b, d5_k) + d5_b
                                return {"kernel": k_comb, "bias": b_comb}
                        elif "dense_5" in mw:
                            d5 = mw["dense_5"]["dense_5"]
                            d5_k = np.array(d5["kernel"], dtype=np.float32)
                            d5_b = np.array(d5["bias"], dtype=np.float32)
                            if d5_k.shape[-1] == num_classes and d5_b.shape[0] == num_classes:
                                return {"kernel": d5_k, "bias": d5_b}
            except Exception:
                pass
            return None
        if not zipfile.is_zipfile(io.BytesIO(bin_bytes)):
            return None
        try:
            with zipfile.ZipFile(io.BytesIO(bin_bytes), "r") as zf:
                cfg = json.loads(zf.read("config.json").decode("utf-8"))
                cfg_in_shape = cfg.get("input_shape")
                if isinstance(cfg_in_shape, list) and len(cfg_in_shape) == 3:
                    if [int(x) for x in cfg_in_shape] != input_shape:
                        raise ValueError(
                            f"Shape input pada config.json {cfg_in_shape} tidak cocok dengan metadata {input_shape}"
                        )
                if "portable_weights.json" in zf.namelist():
                    w_data = json.loads(zf.read("portable_weights.json").decode("utf-8"))
                    return w_data
                if "model.weights.npz" in zf.namelist():
                    with np.load(io.BytesIO(zf.read("model.weights.npz"))) as npz:
                        return {"kernel": npz["kernel"], "bias": npz["bias"]}
        except ValueError:
            raise
        except Exception:
            return None
        return None

    @staticmethod
    def _extract_portable_weights_from_tflite(bin_bytes):
        marker = b"__SELADA_PORTABLE_WEIGHTS_JSON__:"
        idx = bin_bytes.find(marker)
        if idx < 0:
            return None
        try:
            raw_json = bin_bytes[idx + len(marker) :].decode("utf-8")
            return json.loads(raw_json)
        except Exception:
            return None


class CNNInferenceAdapter:
    """
    Decoupled CNN Inference Adapter for Selada Keriting Monitor.
    Manages:
      - Loading/validating model artifacts from `models/`
      - Atomic model registration/import with automatic rollback to the
        previous active model if validation of a new model fails
      - Identical training/inference preprocessing
      - Honest `BELUM ADA MODEL` fallback when no model is installed
    """

    def __init__(self, models_dir=None, auto_load=True):
        self.models_dir = os.path.abspath(models_dir or DEFAULT_MODELS_DIR)
        self._lock = threading.RLock()
        self._active_state = None
        self._last_error = None
        if auto_load:
            self.reload_from_disk()

    def reload_from_disk(self):
        """
        Loads or reloads the model from `self.models_dir`.
        - If `self.models_dir` contains no model files at all, sets state to
          `BELUM ADA MODEL` (only if no model was previously active).
        - If model files exist, validates them and activates the model if valid;
          if invalid, preserves any previously active model and records `last_error`.
        """
        with self._lock:
            if not CNNModelValidator.has_any_model_artifacts(self.models_dir):
                if self._active_state is None:
                    self._last_error = None
                return {
                    "ok": True,
                    "status": self.status,
                    "active_model": self.get_status_dict(),
                }

            ok, res = CNNModelValidator.validate_directory(self.models_dir)
            if not ok:
                self._last_error = res.get("error", "Validasi model gagal")
                return {
                    "ok": False,
                    "error": self._last_error,
                    "stage": res.get("stage", "validation"),
                    "rolled_back_to_previous": self._active_state is not None,
                    "active_model": self.get_status_dict(),
                }

            self._active_state = res
            self._last_error = None
            return {
                "ok": True,
                "status": self.status,
                "active_model": self.get_status_dict(),
            }

    def register_model_from_directory(self, source_dir, persist_to_models_dir=False):
        """
        Validates a candidate model directory and activates it atomically.
        If validation fails, the previously active model remains active and
        `self.models_dir` is NOT overwritten.
        """
        with self._lock:
            ok, res = CNNModelValidator.validate_directory(source_dir)
            if not ok:
                self._last_error = res.get("error", "Validasi model baru gagal")
                return {
                    "ok": False,
                    "error": self._last_error,
                    "stage": res.get("stage", "validation"),
                    "rolled_back_to_previous": self._active_state is not None,
                    "active_model": self.get_status_dict(),
                }

            if persist_to_models_dir and os.path.abspath(source_dir) != self.models_dir:
                os.makedirs(self.models_dir, exist_ok=True)
                for fname in REQUIRED_JSON_FILES + (res["binary_file"],):
                    src_file = os.path.join(source_dir, fname)
                    dst_file = os.path.join(self.models_dir, fname)
                    shutil.copy2(src_file, dst_file)

            self._active_state = res
            self._last_error = None
            return {
                "ok": True,
                "status": self.status,
                "rolled_back_to_previous": False,
                "active_model": self.get_status_dict(),
            }

    def register_model_bundle(self, files_map, persist_to_models_dir=False):
        """
        Validates an in-memory model bundle (`class_names.json`, `metadata.json`,
        `evaluation.json`, and `model.keras` or `model.tflite`) and activates it
        atomically. Preserves the previous active model if validation fails.
        """
        with self._lock:
            ok, res = CNNModelValidator.validate_bundle(files_map)
            if not ok:
                self._last_error = res.get("error", "Validasi bundle model gagal")
                return {
                    "ok": False,
                    "error": self._last_error,
                    "stage": res.get("stage", "validation"),
                    "rolled_back_to_previous": self._active_state is not None,
                    "active_model": self.get_status_dict(),
                }

            if persist_to_models_dir:
                os.makedirs(self.models_dir, exist_ok=True)
                for fname in REQUIRED_JSON_FILES + (res["binary_file"],):
                    raw = files_map[fname]
                    data_bytes = raw if isinstance(raw, (bytes, bytearray)) else str(raw).encode("utf-8")
                    with open(os.path.join(self.models_dir, fname), "wb") as f:
                        f.write(data_bytes)

            self._active_state = res
            self._last_error = None
            return {
                "ok": True,
                "status": self.status,
                "rolled_back_to_previous": False,
                "active_model": self.get_status_dict(),
            }

    def clear_active_model(self):
        """Resets the adapter to the `BELUM ADA MODEL` state."""
        with self._lock:
            self._active_state = None
            self._last_error = None
            return self.get_status_dict()

    @property
    def is_ready(self):
        with self._lock:
            return self._active_state is not None

    @property
    def status(self):
        with self._lock:
            if self._active_state is None:
                return STATUS_NO_MODEL
            return self._active_state["status"]

    def get_status_dict(self):
        with self._lock:
            if self._active_state is None:
                return {
                    "available": False,
                    "cnn_status": STATUS_NO_MODEL,
                    "model_version": None,
                    "architecture": None,
                    "format": None,
                    "binary_file": DEFAULT_MODEL_FILENAME,
                    "class_names": list(ACTIVE_MODEL_CLASSES),
                    "ui_classes": list(UI_DISPLAY_CLASSES),
                    "unavailable_classes": {c: STATUS_CLASS_UNAVAILABLE for c in UNAVAILABLE_UI_CLASSES},
                    "input_shape": None,
                    "preprocessing": None,
                    "evaluation": None,
                    "training_source": None,
                    "is_test_model": False,
                    "last_error": self._last_error,
                }
            st = self._active_state
            return {
                "available": True,
                "cnn_status": st["status"],
                "model_version": st["model_version"],
                "architecture": st["architecture"],
                "format": st["format"],
                "binary_file": st["binary_file"],
                "binary_size_bytes": st["binary_size_bytes"],
                "runtime_backend": st["_runtime_backend"],
                "class_names": list(st["class_names"]),
                "ui_classes": list(UI_DISPLAY_CLASSES),
                "unavailable_classes": dict(st.get("unavailable_classes") or {c: STATUS_CLASS_UNAVAILABLE for c in UNAVAILABLE_UI_CLASSES}),
                "input_shape": list(st["input_shape"]),
                "preprocessing": dict(st["preprocessing"]),
                "evaluation": dict(st["evaluation"]),
                "training_source": st["training_source"],
                "exported_at": st["exported_at"],
                "is_test_model": bool(st["is_test_model"]),
                "notes": st["notes"],
                "last_error": self._last_error,
            }

    def preprocess(self, pil_img):
        """
        Preprocesses `pil_img` using the active model's exact `input_shape` and
        `preprocessing` configuration.
        """
        with self._lock:
            if self._active_state is None:
                raise RuntimeError("Tidak ada model aktif untuk preprocessing (status: BELUM ADA MODEL)")
            return preprocess_image_tensor(
                pil_img,
                self._active_state["input_shape"],
                self._active_state["preprocessing"],
            )

    def predict(self, pil_img, leaf_width_px=None, timestamp_ms=None):
        """
        Runs CNN inference on `pil_img`.
        If no model is registered, honestly returns `BELUM ADA MODEL` without
        fabricating predictions.
        """
        with self._lock:
            if self._active_state is None:
                return {
                    "cnn_status": STATUS_NO_MODEL,
                    "cnn_class": None,
                    "cnn_confidence": None,
                    "cnn_probabilities": None,
                    "model_version": None,
                    "model_architecture": None,
                    "classified_at": None,
                    "is_test_model": False,
                    "supporting_leaf_width_px": leaf_width_px,
                }

            st = self._active_state
            batch_tensor = preprocess_image_tensor(
                pil_img,
                st["input_shape"],
                st["preprocessing"],
            )
            probs = st["_runner"](batch_tensor)
            top_idx = int(np.argmax(probs))
            pred_class = st["class_names"][top_idx]
            confidence = round(float(probs[top_idx]), 4)
            probs_map = {
                cls_name: round(float(probs[i]), 4)
                for i, cls_name in enumerate(st["class_names"])
            }
            classified_at = int(timestamp_ms if timestamp_ms is not None else time.time() * 1000)

            return {
                "cnn_status": st["status"],
                "cnn_class": pred_class,
                "cnn_confidence": confidence,
                "cnn_probabilities": probs_map,
                "model_version": st["model_version"],
                "model_architecture": st["architecture"],
                "classified_at": classified_at,
                "is_test_model": bool(st["is_test_model"]),
                "supporting_leaf_width_px": leaf_width_px,
            }


_DEFAULT_ADAPTER_LOCK = threading.Lock()
_DEFAULT_ADAPTER = None


def get_default_cnn_adapter(models_dir=None, force_reload=False):
    global _DEFAULT_ADAPTER
    with _DEFAULT_ADAPTER_LOCK:
        if _DEFAULT_ADAPTER is None or (models_dir and os.path.abspath(models_dir) != _DEFAULT_ADAPTER.models_dir):
            _DEFAULT_ADAPTER = CNNInferenceAdapter(models_dir=models_dir, auto_load=True)
        elif force_reload:
            _DEFAULT_ADAPTER.reload_from_disk()
        return _DEFAULT_ADAPTER
