# Direktori Model CNN Eksternal (`models/`) · Selada Keriting Monitor

Seluruh pelatihan (*training*) model Convolutional Neural Network (CNN) untuk **Selada Keriting Smart Monitor (Kelompok 5)** dilakukan **secara eksternal di Google Colab**. Repository ini **tidak melakukan training CNN secara internal** dan hanya bertugas:
1. Mengelola serta mengekspor dataset berlabel (`train` / `validation` / `test`) melalui **CNN Dataset Manager**.
2. Memvalidasi, meregistrasikan, dan menjalankan *inference* model hasil ekspor Google Colab (`model_selada_v2.h5`, `model.keras`, `model.tflite`) melalui **CNN Inference Adapter** (`scripts/cnn_inference_adapter.py` dan `js/growth.js`).

Apabila belum ada berkas model yang dipasang di direktori `models/`, seluruh pipeline dan dashboard menampilkan status jujur **`BELUM ADA MODEL`** tanpa mengarang atau mensimulasikan hasil klasifikasi.

---

## 1. Antarmuka 4 Kelas Dosen & Integrasi 3 Kelas Aktif `model_selada_v2.h5`

Sesuai spesifikasi dosen pengampu, antarmuka sistem **mempertahankan tampilan 4 kelas**:
1. **Siap Panen** (`siap_panen`) — **Aktif** terhubung ke model
2. **Mendekati Panen** (`mendekati_panen`) — **Aktif** terhubung ke model
3. **Masa Pertumbuhan** (`masa_pertumbuhan`) — **Aktif** terhubung ke model
4. **Bukan Selada** (`bukan_selada`) — **Elemen UI Informatif** berstatus badge **`BELUM TERSEDIA`**

### Kebijakan Integritas Model & Data:
- Tiga kelas pertama (`siap_panen`, `mendekati_panen`, `masa_pertumbuhan`) terhubung secara nyata ke output inferensi `model_selada_v2.h5`.
- Kelas **Bukan Selada** murni elemen UI informatif:
  - Ditandai badge **`BELUM TERSEDIA`**.
  - **Tanpa fungsi klasifikasi** pada model 3-kelas saat ini.
  - **Tanpa confidence score palsu** dan **tanpa probabilitas buatan**.
  - **Dilarang keras dimasukkan ke output prediksi inferensi model**.
- Statistik dan visualisasi di dashboard membedakan secara tegas kelas yang aktif dengan kelas yang belum tersedia.
- Validasi model **tidak memaksakan 4 kelas** pada model 3-kelas dan **tidak mengubah urutan output asli** model.
- Model asli `model_selada_v2.h5` beserta konfigurasi preprocessing aslinya dipertahankan penuh tanpa training ulang.

---

## 2. Struktur Berkas Model di `models/`

Setelah proses *training* dan evaluasi selesai di Google Colab, tempatkan berkas-berkas berikut ke dalam direktori `models/`:

```text
models/
├── README.md               # Dokumentasi integrasi & spesifikasi model
├── model_selada_v2.h5      # Berkas model utama HDF5 Keras v2/v3
│   (atau model.h5 / model.keras / model.tflite)
├── class_names.json        # Daftar 3 kelas output asli model (indeks 0..2)
├── metadata.json           # Kontrak arsitektur, versi, input_shape, dan preprocessing
└── evaluation.json         # Metrik evaluasi 3 kelas pada test split di Google Colab
```

---

## 3. Kontrak 3 Kelas Output Model & Urutan Label (`class_names.json`)

`class_names.json` memuat 3 nama kelas output yang dihasilkan oleh layer *softmax* model `model_selada_v2.h5`. Urutan indeks output model (`0..2`) **wajib identik** antara `class_names.json`, `metadata.json`, dan `evaluation.json`:

```json
[
  "siap_panen",
  "mendekati_panen",
  "masa_pertumbuhan"
]
```

> **Penting**: Urutan di atas merefleksikan urutan tensor output model. Sistem **tidak mengubah urutan output** model dan **tidak menyisipkan kelas bukan_selada** ke dalam layer klasifikasi model.

---

## 4. Spesifikasi `metadata.json` & Kesamaan Preprocessing

Konfigurasi `preprocessing` pada `metadata.json` dieksekusi secara deterministik oleh `preprocess_image_tensor()` sehingga preprocessing inferensi identik dengan proses pelatihan di Colab:

```json
{
  "model_id": "model_selada_v2",
  "model_version": "v2.0.0-colab",
  "architecture": "MobileNetV2",
  "format": "h5",
  "binary_file": "model_selada_v2.h5",
  "training_source": "google_colab",
  "exported_at": "2026-11-03T12:00:00Z",
  "is_test_model": false,
  "input_shape": [224, 224, 3],
  "class_names": [
    "siap_panen",
    "mendekati_panen",
    "masa_pertumbuhan"
  ],
  "preprocessing": {
    "color_mode": "RGB",
    "resize_mode": "bilinear",
    "target_size": [224, 224],
    "normalization": "rescale_0_1"
  },
  "supporting_measurement": "leaf_width_px",
  "notes": "Model Selada Keriting v2 dilatih di Google Colab (3 kelas output aktif)"
}
```

### Mode Normalisasi yang Didukung (`preprocessing.normalization`)
| Nilai `normalization` | Rumus Transformasi Piksel (`float32` RGB `0..255`) | Keterangan di Google Colab |
| :--- | :--- | :--- |
| `"rescale_0_1"` | `x / 255.0` | `tf.keras.layers.Rescaling(1./255)` |
| `"mobilenet_v2_-1_1"` | `(x / 127.5) - 1.0` | `tf.keras.applications.mobilenet_v2.preprocess_input` |
| `"imagenet_mean_std"` | `((x / 255.0) - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]` | Standar Torch/ImageNet RGB |
| `"raw_0_255"` | `x` (`float32` `0.0..255.0`) | Bila layer `Rescaling` sudah tertanam di dalam grafik model |

---

## 5. Spesifikasi `evaluation.json`

Berisi metrik hasil pengujian model pada *test split* di Google Colab untuk 3 kelas aktif, dengan *confusion matrix* `3x3`:

```json
{
  "accuracy": 0.9425,
  "precision_macro": 0.9410,
  "recall_macro": 0.9385,
  "f1_macro": 0.9397,
  "test_samples": 120,
  "class_names": [
    "siap_panen",
    "mendekati_panen",
    "masa_pertumbuhan"
  ],
  "confusion_matrix": [
    [38, 2, 0],
    [1, 39, 1],
    [0, 1, 39]
  ]
}
```

---

## 6. Langkah Pemasangan & Registrasi Model

1. **Ekspor Dataset dari Dashboard**:
   Buka menu **Kamera & CNN -> CNN Dataset Manager**, lalu klik **Ekspor Split Train/Val/Test** untuk mengunduh manifest JSON pembagian dataset terstratifikasi (`70% train`, `15% validation`, `15% test`).
2. **Latih & Ekspor di Google Colab**:
   Latih model pada Google Colab dengan konfigurasi 3 kelas output, unduh berkas model (`model_selada_v2.h5`), `class_names.json`, `metadata.json`, dan `evaluation.json`.
3. **Pasang ke Direktori `models/` atau Unggah via Panel Registrasi Model**:
   - Salin berkas-berkas ke direktori `models/` di root repository, atau
   - Pilih berkas pada panel **Registrasi & Validasi Model Hasil Colab** di antarmuka web.
4. **Validasi 7 Lapis & Proteksi Rollback Atomik**:
   Sistem memvalidasi kelengkapan berkas, 3 kelas output aktif, urutan label, `input_shape`, konfigurasi preprocessing/normalisasi, metrik evaluasi, serta kompatibilitas runtime. Apabila validasi gagal, model baru ditolak dan **model aktif sebelumnya tetap dipertahankan**.
