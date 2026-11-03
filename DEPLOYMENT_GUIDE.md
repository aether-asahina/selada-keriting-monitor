# Panduan Konfigurasi Produksi & Environment Variables · Selada Keriting Monitor

Dokumen ini berisi panduan resmi untuk mempersiapkan deployment produksi **Selada Keriting Smart Monitor (Kelompok 5)** ke Vercel Serverless dan Firebase RTDB.

---

## 1. Daftar Environment Variables Wajib

Konfigurasikan seluruh variabel lingkungan berikut pada **Vercel Dashboard -> Project Settings -> Environment Variables** untuk lingkungan `Production`, `Preview`, dan `Development`:

| Nama Variabel | Wajib / Opsional | Deskripsi & Format | Lokasi Pengambilan |
| :--- | :--- | :--- | :--- |
| `BLOB_READ_WRITE_TOKEN` | **Wajib** | Token Read-Write Vercel Blob untuk penyimpanan berkas citra asli, mask, dan overlay (`vercel_blob_rw_...`). | Vercel Dashboard -> Storage -> Create/Select Blob Store -> `.env.local` tab. |
| `FIREBASE_RTDB_URL` | **Wajib** | URL basis data Firebase Realtime Database. Format: `https://<project-id>-default-rtdb.asia-southeast1.firebasedatabase.app` (tanpa garis miring di akhir). | Firebase Console -> Project Settings -> Realtime Database URL. |
| `CAPTURE_SHARED_TOKEN` | **Wajib** | Token rahasia pra-bagi (Pre-Shared Key / PSK) untuk otentikasi fail-closed antara ESP32-CAM, skrip scheduler, dan endpoint Vercel (`/api/kelompok5/capture` & `/api/kelompok5/dataset`). | Dibuat mandiri (string acak minimal 32 karakter hexadecimal/alphanumeric). |
| `FIREBASE_AUTH_TOKEN` | Opsional | Database secret atau token otentikasi admin jika Firebase RTDB dikonfigurasi dengan aturan ketat `auth != null`. | Firebase Console -> Project Settings -> Service Accounts -> Database Secrets. |
| `CALIB_FACTOR_MM_PER_PX` | Opsional | Faktor kalibrasi kamera tetap (misalnya `0.25` mm per piksel). Jika dikosongkan, sistem menyajikan data fisik dalam satuan piksel (`px`) secara jujur. | Ditentukan melalui pengukuran objek kalibrasi pada dudukan kamera tetap. |

> [!CAUTION]
> **Keamanan Kredensial**: Jangan pernah melakukan *hardcode*, commit, atau mencetak nilai token rahasia ke dalam berkas repositori publik atau log konsol.

---

## 2. Langkah Konfigurasi Firebase RTDB

1. Buka [Firebase Console](https://console.firebase.google.com/) dan pilih project **Selada Keriting Monitor**.
2. Masuk ke menu **Build -> Realtime Database**.
3. Pastikan lokasi database berada di region terdekat: `asia-southeast1` (Singapura).
4. Atur **Security Rules** agar mengizinkan pembacaan publik aman pada node telemetri kelompok dan membatasi penulisan hanya untuk entitas terotentikasi:
   ```json
   {
     "rules": {
       "kelompok5": {
         ".read": true,
         ".write": "auth != null",
         "locks": {
           ".write": "auth != null"
         }
       }
     }
   }
   ```
5. Salin URL database ke environment variable `FIREBASE_RTDB_URL`.

---

## 3. Langkah Konfigurasi Vercel Blob Storage

1. Buka dashboard proyek di [Vercel](https://vercel.com/).
2. Masuk ke tab **Storage**, lalu klik **Create Database** dan pilih **Blob**.
3. Beri nama store (misal: `selada-growth-images`).
4. Setelah store aktif, buka tab **Settings** atau **Quickstart**, salin token `BLOB_READ_WRITE_TOKEN`, lalu simpan di Environment Variables proyek.

---

## 4. Konfigurasi Firmware ESP32-CAM

Agar modul ESP32-CAM dapat mengunggah citra secara mandiri ke backend Vercel:
1. Buka firmware [`firmware/esp32cam_kelompok5_autonomous/esp32cam_kelompok5_autonomous.ino`](file:///storage/emulated/0/Documents/selada-workspace/firmware/esp32cam_kelompok5_autonomous/esp32cam_kelompok5_autonomous.ino).
2. Perbarui konstanta jaringan dan otentikasi:
   ```c
   const char* WIFI_SSID     = "NAMA_WIFI_ANDA";
   const char* WIFI_PASS     = "PASSWORD_WIFI_ANDA";
   const char* VERCEL_HOST   = "proyek-selada.vercel.app";
   const char* SHARED_TOKEN  = "NILAI_CAPTURE_SHARED_TOKEN_ANDA";
   ```
3. Lakukan kompilasi dan flash firmware ke ESP32-CAM menggunakan Arduino IDE / ESP-IDF.

---

## 5. Status Kompatibilitas Model CNN & Serverless Vercel

- **Berkas Model**: Berkas `models/model_selada_v2.h5` (11.5 MB) telah dipaketkan ke dalam repositori bersama `class_names.json`, `metadata.json`, dan `evaluation.json`.
- **Dependensi Serverless**: Berkas [`requirements.txt`](file:///storage/emulated/0/Documents/selada-workspace/requirements.txt) sengaja dipertahankan ringan (`numpy`, `Pillow`) agar ukuran bundle serverless Vercel tetap **<50 MB**, jauh di bawah batas keras Vercel (250 MB).
- **Catatan Inferensi Serverless**: Di lingkungan serverless tanpa runtime C++ TensorFlow, adapter Python menjalankan linear classification head projection. Untuk inferensi konvolusi penuh tanpa batas kuota serverless, disarankan menggunakan format terkonversi TFLite (`tflite_runtime`) atau inferensi sisi peramban (*client-side*) via TensorFlow.js.
