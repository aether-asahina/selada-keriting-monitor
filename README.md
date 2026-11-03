# Selada Keriting Smart Monitor & Irigasi Histeresis · Kelompok 5 (Lactuca sativa L.)

Sistem telemetri IoT mikroklimat presisi **Kelompok 5**, otomasi irigasi histeresis, Decision Support System (DSS) agronomi, dan pemantauan otomatis pertumbuhan daun selada keriting (*Lactuca sativa L. var. crispa*) berbasis Computer Vision selama siklus 42 hari dengan scheduler mandiri berbasis Wi-Fi pada ESP32-CAM. Dibangun dengan standar antarmuka profesional (Dark Palette `#090d16` & `#111827`, border `1px solid rgba(255,255,255,0.08)`, aksen `#3b82f6`, `#10b981`, `#f59e0b`, `#ef4444`, tipografi Inter & JetBrains Mono `tabular-nums`, ikon SVG Lucide 1.75px, zero AI emojis) dengan arsitektur responsif bebas luapan kontainer pada seluruh rentang viewport (320px s.d 1920px).

---


### Menjalankan Receiver Foto Wi-Fi (tanpa microSD)

1. Pastikan komputer server dan ESP32-CAM berada pada jaringan Wi-Fi/LAN yang sama.
2. Instal dependensi Python proyek (terutama Pillow dan OpenCV yang digunakan pipeline CV).
3. Jalankan receiver dari root repository:

   ```bash
   python scripts/scheduler_daemon.py --receiver --host 0.0.0.0 --port 8081
   ```

4. Pada firmware `esp32cam_kelompok5_autonomous.ino`, sesuaikan `WIFI_SSID`, `WIFI_PASS`, dan `RECEIVER_URL` dengan jaringan serta alamat IPv4 komputer server. `RECEIVER_URL` harus berakhir dengan `/api/kelompok5/capture`.
5. Upload firmware ke AI-Thinker ESP32-CAM. Cek `http://IP_KAMERA/status` dan stream `http://IP_KAMERA:81/stream`.

ESP32-CAM menjalankan satu-satunya scheduler capture: 07:00 sampai 16:50 WIB, interval 10 menit. Python hanya menerima JPEG, memvalidasi ukuran/checksum/slot, menyimpan file dan metadata, lalu menjalankan CV. Browser hanya menampilkan status dan data, bukan pemicu jadwal. Karena tidak ada microSD, foto pada slot yang gagal dikirim tidak memiliki antrean lokal dan perlu ditangani sebagai slot gagal.


## 1. Arsitektur Sistem & Alur Data Terintegrasi

```mermaid
flowchart TD
    subgraph Edge_Hardware ["Lapisan Lapangan (Edge Hardware & Sensor)"]
        ESP32["ESP32 Microcontroller<br/>(Telemetri & Histeresis)"]
        DHT22["Sensor DHT22<br/>(Suhu & Kelembapan Udara)"]
        SOIL["Sensor Kapasitif HW-390<br/>(Kelembapan Tanah)"]
        RELAY["Modul Relay 5V Aktif-LOW<br/>(Pompa Irigasi GPIO 26)"]
        CAM["ESP32-CAM OV2640<br/>(Overhead Kanopi Selada)"]
        
        DHT22 -->|GPIO 4| ESP32
        SOIL -->|GPIO 34 ADC1| ESP32
        ESP32 -->|GPIO 26 Control| RELAY
    end

    subgraph Edge_Backend ["Lapisan Backend Edge & Scheduler Daemon"]
        SCHED["Scheduler Daemon (Python 3)<br/>(10-Min Slot, 07:00-16:50 WIB)"]
        CV["Pipeline Computer Vision<br/>(ExG Otsu, Morfologi, Kontur)"]
        STORE["Penyimpanan Terpisah<br/>(/data/growth_images & JSON)"]
        
        SCHED -->|HTTP Snapshot /capture| CAM
        SCHED -->|Raw Frame RGB| CV
        CV -->|Orig, Mask PNG, Overlay JPG| STORE
    end

    subgraph Cloud_Infrastructure ["Lapisan Cloud & Gateway"]
        RTDB["Firebase Realtime Database<br/>asia-southeast1.firebasedatabase.app"]
        RULES["Security Rules<br/>(Allowlist read / Authenticated write)"]
        
        ESP32 -->|HTTPS REST / WebSocket 1s| RTDB
        RTDB --- RULES
    end

    subgraph Client_App ["Dashboard Web Profesional (11 Modul Halaman)"]
        SEC["Security Layer<br/>(XSS Allowlist, CSV Defense CWE-1236, Host Sanitize)"]
        ROUTER["Data Demux & Store<br/>(Live RTDB / Offline-Cache / Zero-Dummy)"]
        GROWTH["Leaf Growth Manager<br/>(Sinkronisasi Galeri & Metrik Kanopi)"]
        SCADA["SCADA Controller<br/>(Pump Command Setpoint vs Relay Feedback)"]
        DSS["Sistem Pakar Agronomi<br/>(Tetens VPD & Physiological GDD)"]
        UI["11 Modul Tampilan Navigasi<br/>(Dashboard, Sensor, Kamera, Pertumbuhan Daun, Riwayat, Analisis Tanaman, AI Assistant, Otomasi, Peringatan, Pengaturan, Panduan)"]
        
        RTDB -->|Polling Mutex / Fetch Lock| ROUTER
        STORE -->|JSON Fetch & Static Asset| GROWTH
        CAM -.->|Local Subnet MJPEG| UI
        ROUTER --> SEC
        SEC --> SCADA
        SEC --> DSS
        GROWTH --> UI
        SCADA --> UI
        DSS --> UI
    end
```

---

## 2. Tiga Pekerjaan Utama yang Diimplementasikan

### (1) Redesign Dashboard: Professional Agricultural Monitoring (Kelompok 5)
Dashboard dirancang ulang secara menyeluruh mengikuti estetika IoT pertanian modern premium:
- **Palet Warna**: Canvas `#090d16`, panel/surface `#111827`, border tipis `1px solid rgba(255,255,255,0.08)`, aksen biru Linear `#3b82f6`, indikator hijau `#10b981` (kondisi optimal), kuning `#f59e0b` (peringatan), merah `#ef4444` (kritis).
- **Sidebar Navigasi Proporsional (11 Modul Fungsional)**:
  1. **Dashboard (`#ringkasan`)**: Pusat monitoring utama dengan ringkasan status perangkat/kamera/koneksi kamera/unggah Wi-Fi/HST, 4 KPI kartu fisik utama, grafik interaktif lebar (Suhu Udara, Kelembapan Udara, Kelembapan Tanah, Riwayat Status Pompa/Relay, serta Progres Pertumbuhan Tanaman Citra Aktual), Live Camera IP lokal, Galeri Capture Aktual, Log Telemetri, dan Evaluasi Pakar.
  2. **Sensor (`#sensor`)**: Detail telemetri sensor tanah, suhu, udara, zona histeresis, dan korelasi scatter plot dalam grid 2 kolom seimbang.
  3. **Kamera (`#kamera`)**: Live streaming ESP32-CAM (`http://<IP>:81/stream`), status kamera & upload Wi-Fi tervalidasi FNV-1a, snapshot manual, dan galeri sesi.
  4. **Pertumbuhan Daun (`#pertumbuhan-daun`)**: Dasbor kampanye 42 hari, progres target 1.600 gambar, countdown 10 menit, 4 grafik trajektori kanopi, galeri filterable, dan modal inspeksi segmentasi side-by-side.
  5. **Riwayat (`#riwayat`)**: Log telemetri per pembacaan / per menit dengan paginasi, pengurutan kolom, dan unduh CSV aman CWE-1236.
  6. **Analisis Tanaman (`#analisis-tanaman`)**: DSS fisiologi tanaman dengan dekomposisi Tetens VPD dan model termal GDD ($T_{\text{base}} = 4.0^\circ\text{C}$).
  7. **AI Assistant (`#ai-assistant`)**: Halaman khusus asisten percakapan cerdas dengan auto-diagnosis real-time dan chip topik konsultasi cepat.
  8. **Otomasi (`#otomasi`)**: Pengendali irigasi histeresis SCADA dengan pemisahan `pumpCommand` vs `relayActual` dan batas timeout 120 detik.
  9. **Peringatan (`#peringatan`)**: Daftar kejadian telemetri real-time dan konfigurasi aturan ambang batas.
  10. **Pengaturan (`#pengaturan`)**: Konfigurasi URL Firebase RTDB Kelompok 5, interval polling, deadband histeresis, tema, dan preferensi satuan.
  11. **Panduan (`#panduan`)**: Diagram alur kerja IoT, langkah instalasi step-by-step, troubleshooting, skema JSON RTDB Kelompok 5, dan pinout lengkap.
- **Header Global Ringkas**: Menampilkan judul sistem, rentang tanggal / jam aktual WIB, status koneksi Firebase Kelompok 5 & ESP32-CAM, dan badge jumlah peringatan aktif.
- **Top Area: Ringkasan Perangkat & 4 KPI Kartu Fisik**:
  - *Status Perangkat & Kampanye*: Koneksi ESP32 (`/kelompok5`), Live Camera (`/stream`), Koneksi Kamera Wi-Fi, Upload JPEG (`FNV-1a`), dan Target Foto Valid (`0 / 1.600`).
  - *Sensor Fisik Terpasang & Aktuator*: Kelembapan Tanah (HW-390, target 65–78%), Suhu Udara (DHT22, target 15–24°C), Kelembapan Udara (DHT22, target 60–80%), serta Status Pompa & Relay Irigasi (`ON / OFF`).
- **Main Area: 3 Panel Komposisi Utama**:
  1. *Live Camera View*: Preview kanopi ESP32-CAM dengan badge status LIVE/OFFLINE, resolusi SVGA 800×600, timestamp WIB, dan tombol reconnect.
  2. *Plant Health Analysis*: Foto tanaman aktual dengan toggle overlay kontur/siluet/asli, kondisi tanaman fisiologis, lebar maksimal daun (px), luas siluet (px²), dan status evaluasi kualitas QC.
  3. *AI Recommendations*: Rekomendasi agronomi real-time berdasarkan aturan histeresis, batas Tetens VPD, pencegahan tipburn, toleransi suhu bolting, dan GDD.
- **Analytics Section**: Grafik primer telemetri real-time multi-metrik disertai 4 subgrid grafik pertumbuhan kanopi daun (Lebar, Luas, Growth Rate, GDD).
- **Alerts & Notifications**: Notifikasi dinamis untuk kamera offline, aliran telemetri sensor, pelanggaran ambang batas mikroklimat, dan progres kuota dataset 1.600 gambar.
- **Bottom Stats Bar**: 7 metrik ringkas: Total Gambar, Gambar Valid, Gambar Gagal, Sensor Aktif (3 unit), Progres Target (%), Durasi Monitoring (HST), dan Status Sistem SCADA.
- **Mobile Responsive Drawer**: Pada viewport mobile/tablet, sidebar otomatis bertransformasi menjadi drawer tersembunyi dengan tombol pemicu hamburger `#menuToggle`, tombol tutup `#sideclose`, dan backdrop redup `#mobileBackdrop`. Panel bertumpuk secara vertikal, touch target $\ge 44\text{px}$, dan tabel dilengkapi pembungkus scroll horizontal internal (`overflow-x: auto`).

---

### (2) Chart dan Responsive UI Bug Fix
- **Identifikasi Akar Masalah (Root Cause Analysis)**:
  1. *Flex/Grid Child Minimum Sizing*: Elemen flex/grid item secara default memiliki `min-width: auto`, sehingga kanvas grafik dan tabel lebar mencegah kontainer mengecil di layar kecil.
  2. *Unconstrained SVG Attributes*: Elemen `<svg>` tanpa atribut `width="100%"` dan `style="display:block; overflow:hidden;"` serta CSS `overflow: visible` pada kelas `.chart` mengakibatkan grafik meluap keluar batas saat dirender pada viewport sempit.
  3. *Ketiadaan ResizeObserver*: Perubahan viewport atau orientasi perangkat tidak memicu penghitungan ulang koordinat grafik, sehingga `viewBox` tetap menggunakan ukuran lebar desktop lama.
  4. *Dataset Edge-Cases*: Dataset kosong (0 record) atau data tunggal (1 record) menyebabkan pembagian dengan nol (`innerW / 0`) dan kegagalan pembuatan path SVG.
- **Solusi Rekayasa yang Diterapkan**:
  - Menetapkan universal reset `box-sizing: border-box`, `html, body { overflow-x: hidden; }`.
  - Menerapkan `min-width: 0; max-width: 100%; width: 100%; overflow: hidden;` pada seluruh panel, kartu KPI, dan wrapper grafik (`#chartSvgWrap`, `.chart-svg-wrap`, `.chart`).
  - Mengintegrasikan `ResizeObserver` dengan debouncing 50ms untuk mendeteksi perubahan lebar kontainer secara reaktif tanpa menduplikasi instans chart.
  - Penanganan kasus batas (Edge Cases):
    - *0 record*: Menampilkan placeholder informatif "Menunggu paket telemetri pertama dari sensor…".
    - *1 record*: Merender garis acuan horizontal putus-putus dengan titik tengah berlabel waktu dan nilai sensor, tanpa pembagian dengan nol.
    - *> 300 record*: Menerapkan algoritma desimasi linier bertahap untuk menjaga performa rendering DOM tetap pada 60 FPS.
    - *Filter Nilai Tak Terhingga/NaN*: Validasi `Number.isFinite(r.t) && Number.isFinite(r[metric])` sebelum kalkulasi koordinat.
    - *Label Sumbu Waktu*: Format waktu ringkas (`HH:mm:ss`) dengan text-anchor dinamis (`start` pada titik awal, `end` pada titik akhir, `middle` pada interior).
- **Hasil Pengujian Viewport**:
  Teruji bebas horizontal overflow dan bebas elemen bertumpuk pada 8 target breakpoint:
  - `320×720` (Ultra-narrow Mobile)
  - `360×800` (Android Standard)
  - `390×844` (iPhone 12/13/14)
  - `430×932` (iPhone Pro Max)
  - `768×1024` (iPad Portrait)
  - `1024×768` (iPad Landscape)
  - `1366×768` (Laptop WXGA)
  - `1920×1080` (Desktop Full HD)

---

### (3) Automated 42-Day Lettuce Leaf Growth Campaign & CV Pipeline
- **Spesifikasi Kampanye Otomasi**:
  - **Durasi Siklus**: 42 Hari Setelah Tanam (HST).
  - **Frekuensi Capture**: Setiap 10 menit mulai pukul 07:00 WIB hingga 16:50 WIB.
  - **Kapasitas Slot Harian**: 60 kesempatan capture per hari.
  - **Total Kesempatan**: $60\text{ slot/hari} \times 42\text{ hari} = 2.520\text{ kesempatan}$.
  - **Target Minimal Valid**: 1.600 gambar tervalidasi lolos QC (tingkat keberhasilan minimal $63.5\%$).
- **Scheduler Daemon Independen (`scripts/scheduler_daemon.py`)**:
  - Beroperasi independen dari browser/UI pada lapisan server/edge Termux/Linux.
  - Menggunakan zona waktu resmi `Asia/Jakarta` (WIB, UTC+7).
  - **Pencegahan Duplikasi**: Kunci slot harian `YYYY-MM-DD_HH:MM` dicatat dalam indeks set memori dan berkas metadata sehingga slot yang sama tidak akan dieksekusi ulang.
  - **Pemulihan Restart (Crash Recovery)**: Pada saat daemon dijalankan ulang, seluruh slot historis dibaca dari `data/growth_metadata.json` untuk melanjutkan jadwal tanpa interupsi.
  - **Timeout & Retry**: Percobaan HTTP snapshot ke ESP32-CAM dibatasi timeout 6 detik dengan maksimal 3 kali percobaan bertahap.
  - **Pencatatan Kegagalan yang Jujur**: Bila kamera mati/offline, sistem mencatat status `FAILED` dan kualitas `INVALID_OFFLINE` dengan nilai lebar dan luas 0 pixel. Sistem **tidak pernah** mengganti gambar gagal dengan gambar sintetis buatan.
- **Pipeline Computer Vision (`scripts/growth_cv_pipeline.py`)**:
  1. *Validasi Kualitas Gambar*: Evaluasi luminansi rata-rata ($Y = 0.299R + 0.587G + 0.114B$) menolak gambar terlalu gelap ($< 20.0$) atau overexposed ($> 238.0$). Evaluasi variansi konvolusi Laplacian $3\times3$ menolak gambar buram/defokus ($< 30.0$).
  2. *Central ROI Crop*: Pemotongan margin batas 8% untuk mengeliminasi gangguan bingkai pot/netpot luar.
  3. *Segmentasi Vegetasi Excess Green Index (ExG)*:
     $$ExG = 2G - R - B$$
     Pemisahan kanopi selada hijau menggunakan ambang adaptif Otsu pada piksel bernilai positif.
  4. *Morfologi Noise Elimination*: Operasi *Morphological Opening* ($3\times3$ Min-Max filter) menghapus titik derau latar, diikuti *Morphological Closing* ($5\times5$ Max-Min filter) menyatukan celah tulang daun internal.
  5. *Ekstraksi Kontur & Pengukuran*:
     - **Lebar Maksimal Daun (`leaf_width_px`)**: Jarak horizontal terjauh kanopi terpotong.
     - **Luas Siluet Kanopi (`leaf_area_px`)**: Jumlah total piksel biner kanopi selada.
  6. *Penyimpanan Terpisah*:
     - Gambar Asli: `data/growth_images/<image_id>_orig.jpg`
     - Siluet Hitam-Putih: `data/growth_images/<image_id>_mask.png`
     - Overlay Kontur & Bounding Box: `data/growth_images/<image_id>_overlay.jpg`
     - Metadata Lengkap: `data/growth_metadata.json`
- **Kebijakan Kalibrasi Fisik (Pixel ke Millimeter)**:
  Sesuai kaidah integritas ilmiah, konversi ke satuan milimeter (`leaf_width_mm`) atau luas fisik milimeter persegi (`leaf_area_mm2`) **hanya dilakukan** bila tersedia faktor kalibrasi objek referensi dengan posisi kamera tetap (`calib_factor_mm_per_px`). Jika belum terkalibrasi, sistem menyajikan data dalam satuan `px` dan `px²` secara transparan.

---

## 3. Struktur Repository & Berkas Modul

```
selada-workspace/
├── css/
│   └── style.css            # Desain sistem Anti-AI-Slop, 12 modul navigasi, responsive breakpoints
├── firmware/
│   ├── esp32_kelompok5_sensor/
│   │   └── esp32_kelompok5_sensor.ino          # Firmware ESP32 Kelompok 5 (Non-blocking millis(), histeresis 65-78%, RTDB /kelompok5)
│   └── esp32cam_kelompok5_autonomous/
│       └── esp32cam_kelompok5_autonomous.ino   # Firmware ESP32-CAM Kelompok 5 (/stream :81, scheduler Wi-Fi mandiri, upload JPEG langsung ke server)
├── js/
│   ├── firebase-config.js   # SecurityUtils (DOM XSS, CWE-1236), ConfigStore (/kelompok5), FirebaseEdgeClient
│   ├── dataset.js           # DatasetStore, statistik telemetri, tabel riwayat, paginasi, export CSV
│   ├── leaf-growth.js       # LeafGrowthManager, polling status kamera dan koneksi Wi-Fi (/status), galeri, modal inspeksi
│   ├── ai-assistant.js      # DSS Agronomi Selada, Tetens VPD, unit termal GDD, chat thread
│   └── dashboard.js         # Pengendali utama, router 12 halaman, live camera /stream, SCADA histeresis, ResizeObserver chart
├── scripts/
│   ├── growth_cv_pipeline.py      # Engine computer vision (ExG Otsu, morfologi, kontur, pengukuran Kelompok 5)
│   └── scheduler_daemon.py        # Daemon otomasi capture 10 menit & HTTP receiver JPEG kamera melalui Wi-Fi (FNV-1a verification)
├── data/
│   ├── growth_images/             # Repositori berkas citra aktual (orig.jpg, mask.png, overlay.jpg)
│   ├── growth_metadata.json       # Metadata terstruktur hasil pengukuran kanopi aktual
│   └── scheduler_daemon.log       # Log eksekusi scheduler independen
├── tests/
│   ├── run-all-tests.js     # Test runner JavaScript komprehensif (Unit, Integration, Firmware & Hardware Audit)
│   └── test_cv_pipeline.py  # Test suite Python untuk engine CV, receiver Wi-Fi dan konfirmasi FNV-1a
├── index.html               # Markup 12 modul UI Kelompok 5, KPI grid, live camera /stream, modal dialog
└── README.md                # Dokumentasi arsitektur Kelompok 5, firmware Wi-Fi, wiring pinout, dan pengujian
```

---

## 4. Konfigurasi Hardware ESP32 & Arsitektur Scheduler Mandiri ESP32-CAM (Kelompok 5)

### A. Firmware ESP32 Sensor & Histeresis (`firmware/esp32_kelompok5_sensor/`)
- **Non-Blocking State Machine (`millis()`)**: Bebas dari `delay()` pemblokir CPU.
- **Filter Median 5-Sampel**: Pembacaan ADC GPIO 34 (HW-390) disaring setiap 50 ms untuk mengeliminasi lonjakan derau elektrik sebelum evaluasi histeresis.
- **Histeresis Pompa & Safety Cutoff**: Pompa GPIO 26 (Aktif-LOW) menyala saat kelembapan tanah $< 65\%$, mati pada $> 78\%$, dilengkapi jeda proteksi sakelar 5 detik dan pemutus darurat (*safety cutoff*) 120 detik.
- **Endpoint Firebase RTDB**: Mengirim payload JSON bertanda `"kelompok": "Kelompok 5"` ke `/kelompok5.json` serta kompatibel dengan struktur `/history` dan `/current`.

### B. Firmware ESP32-CAM Autonomous Wi-Fi Capture (`firmware/esp32cam_kelompok5_autonomous/`)
- **Live Stream Lokal (`/stream`)**: MJPEG tersedia di `http://<IP>:81/stream`, snapshot manual di `http://<IP>/capture`, dan status kamera/Wi-Fi di `http://<IP>/status`.
- **Scheduler Tunggal (10 Menit · 07:00–16:50 WIB · 42 Hari)**: ESP32-CAM mengambil foto pada slot 10-menit. WIB disediakan oleh konfigurasi NTP UTC+7. Awal kampanye dan slot terakhir disimpan di NVS internal ESP32 agar tidak reset saat reboot.
- **Upload Wi-Fi Langsung**: JPEG dikirim melalui HTTP POST ke receiver Python dengan metadata slot, timestamp, HST, ukuran file, dan checksum FNV-1a. Tidak ada microSD, spooler, atau antrean sinkronisasi.
- **Optimasi RAM**: Satu frame buffer digunakan; buffer dikembalikan segera setelah request upload selesai. Stream tetap berjalan pada port 81.
- **Server Receiver dan CV**: `scripts/scheduler_daemon.py --receiver --host 0.0.0.0 --port 8081` menerima JPEG, memvalidasi header/ukuran/checksum/JPEG, mencegah duplikasi slot, menyimpan hasil, lalu menjalankan pipeline CV.
- **Batasan konektivitas**: Karena tidak ada penyimpanan lokal, kamera harus terhubung ke Wi-Fi dan server pada saat jadwal. Slot yang gagal upload ditandai gagal dan tidak memiliki retry/offline queue.

### Skema Pinout ESP32 Microcontroller
| Komponen | Pin Modul | Pin GPIO ESP32 | Keterangan |
| :--- | :--- | :--- | :--- |
| **DHT22** | DATA / OUT | **GPIO 4** | Pull-up resistor $4.7\text{k}\Omega - 10\text{k}\Omega$ ke rail 3.3V |
| **DHT22** | VCC & GND | **3.3V & GND** | Daya stabil mikroklimat |
| **HW-390 / v1.2** | AOUT | **GPIO 34 (ADC1)** | Sensor kelembapan tanah kapasitif bebas korosi |
| **HW-390 / v1.2** | VCC & GND | **3.3V & GND** | Tegangan referensi linear ADC |
| **Relay Modul** | IN | **GPIO 26** | Kontrol logika aktif-LOW (LOW = ON, HIGH = OFF) |
| **Relay Modul** | VCC & JD-VCC | **5V (VIN)** | Catu daya coil relay terpisah untuk stabilitas MCU |

### Skema Modul ESP32-CAM (OV2640)
- **Posisi Kanopi**: Jarak tetap $40 - 50\text{ cm}$ tegak lurus di atas titik tengah roset daun selada.
- **Resolusi Capture Rekomendasi**: SVGA ($800\times600$) atau VGA ($640\times480$).
- **Port Layanan**: Port 80 (Snapshot HTTP `/capture`) dan Port 81 (Stream MJPEG `/stream`).
- **Keamanan Host (SSRF Defense)**: Input host kamera divalidasi ketat terhadap pola IPv4 privat/lokal dan mDNS `.local`, memblokir link-local metadata cloud (`169.254.x.x`).

---

## 5. Cara Menjalankan & Menjalankan Pengujian

### Menjalankan Local Web Server
```bash
cd selada-workspace
python3 -m http.server 8080

# Buka pada browser:
# http://localhost:8080/
```

### Menjalankan Scheduler Daemon 10-Menit (Background Edge)
```bash
# Cek status kampanye capture aktual saat ini
python3 scripts/scheduler_daemon.py --status

# Eksekusi satu slot capture segera ke kamera fisik ESP32-CAM (tanpa simulasi; jika offline dicatat FAILED)
python3 scripts/scheduler_daemon.py --run-once --cam-url http://192.168.1.23/capture

# Jalankan daemon berkelanjutan (07:00–16:50 WIB, interval 10 menit)
python3 scripts/scheduler_daemon.py --daemon --cam-url http://192.168.1.23/capture
```

### Menjalankan Automated Test Suite
Suite pengujian otomatis mengevaluasi seluruh spesifikasi keamanan, integritas data, histeresis SCADA, DSS Tetens/GDD, scheduler, CV pipeline, dan responsive breakpoint:

```bash
# 1. Jalankan pengujian menyeluruh Node.js (109 tes)
node tests/run-all-tests.js

# 2. Jalankan pengujian Computer Vision & Scheduler Python (10 tes)
python3 tests/test_cv_pipeline.py
```

Hasil verifikasi test runner:
```text
================================================================
 SELADA KERITING MONITOR - COMPREHENSIVE AUTOMATED TEST SUITE   
 Target: Security, Integrity, Hysteresis, DSS & Camera Auditing 
================================================================
  Total Executed Tests : 109
  Passed (Verified)    : 105
  Failed               : 0
  Not Tested (Hardware): 4
================================================================
ALL TESTABLE SOFTWARE, SECURITY & INTEGRITY SPECS PASSED!
```

---

## 6. Laporan Keberadaan Hardware & Status Verifikasi

| Komponen / Skenario | Status Verifikasi | Keterangan & Catatan Kejujuran Teknis |
| :--- | :--- | :--- |
| **XSS, Sanitasi & CWE-1236** | **PASS** | Tervalidasi lulus 100% pada ekspor CSV riwayat dan pertumbuhan daun. |
| **Logika Histeresis Pompa** | **PASS** | Tervalidasi transisi ON $<65\%$ dan OFF $>78\%$ dengan pemisahan setpoint vs feedback. |
| **Tetens VPD & Termal GDD** | **PASS** | Formula empiris Tetens ($0.45 - 0.90\text{ kPa}$) dan GDD ($T_{\text{base}} = 4.0^\circ\text{C}$) tervalidasi. |
| **Engine CV & Morfologi** | **PASS** | Segmentasi ExG Otsu, opening/closing morfologi, lebar px, dan luas px² terverifikasi. |
| **Scheduler 10-Menit WIB** | **PASS** | Zona waktu Asia/Jakarta, jendela 07:00-16:50 WIB, deduplikasi, dan recovery teruji. |
| **Responsive 8 Breakpoints** | **PASS** | Bebas luapan horizontal pada 320px, 360px, 390px, 430px, 768px, 1024px, 1366px, 1920px. |
| **ESP32 GPIO 26 Relay Fisik** | **NOT TESTED** | Memerlukan mikrokontroler fisik ESP32 dengan beban pompa riil. |
| **Kalibrasi Analog HW-390** | **NOT TESTED** | Memerlukan pencelupan fisik pada media tanam basah dan kering untuk kurva ADC aktual. |
| **ESP32-CAM OV2640 Fisik** | **NOT TESTED** | Memerlukan modul kamera fisik terhubung pada subnet WiFi lokal port 81. |
| **Firebase RTDB Write Prod** | **NOT TESTED** | Memerlukan kredensial authenticated token produksi untuk pengiriman langsung. |

---

## 7. Lisensi & Etika Riset
Proyek ini dikembangkan di bawah lisensi terbuka untuk tujuan riset pertanian presisi (*Smart Agriculture*) dan komputasi edge (*Edge Internet of Things*). Seluruh data disajikan secara transparan tanpa manipulasi data sensor sintetis palsu.
