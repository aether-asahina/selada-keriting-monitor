/**
 * SELADA KERITING MONITOR - ESP32-CAM AUTONOMOUS WIFI CAPTURE + AP/STA SETUP PORTAL
 * AI-Thinker ESP32-CAM / OV2640. No microSD hardware or synchronization.
 * Dual Mode: Access Point ("DAUN KERITING") + Station (STA) with Web Setup Portal.
 * Port 80  : Web Setup Portal, /save, /capture, /status, /stream redirect.
 * Port 81  : Local MJPEG live video stream (http://CAMERA_IP:81/stream).
 * Autonomous Scheduler: Captures every 10 minutes (07:00-16:50 WIB) over 42 days.
 * Concurrency Safety: FreeRTOS Mutex serializes OV2640 DMA access between capture and stream.
 * Direct Upload: JPEG POSTed directly to Python receiver (/api/kelompok5/capture).
 * Slot Persistence: attemptedSlotKey in RAM, confirmedSlotKey in NVS on HTTP 200 + {"ok":true,"confirmed":true}.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#include <time.h>

// =====================================================
// PIN AI-THINKER ESP32-CAM
// =====================================================
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22
#define LED_STATUS_GPIO   33

// =====================================================
// KONFIGURASI ACCESS POINT & PORTAL
// =====================================================
// AP tetap aktif ketika ESP32-CAM tersambung ke router.
static const char AP_SSID[] = "DAUN KERITING";
static const char AP_PASSWORD[] = "";

static const IPAddress AP_IP(192, 168, 50, 1);
static const IPAddress AP_GATEWAY(192, 168, 50, 1);
static const IPAddress AP_SUBNET(255, 255, 255, 0);

// Default Wi-Fi credentials fallback jika Preferences kosong
static const char WIFI_SSID_DEFAULT[] = "KELOMPOK5_SMART_MONITOR_WIFI";
static const char WIFI_PASS_DEFAULT[] = "CHANGE_ME_IN_PRODUCTION";

// Server target scheduler Python receiver
static const char RECEIVER_URL[] = "http://192.168.1.100:8081/api/kelompok5/capture";
static const char NTP_SERVER[] = "pool.ntp.org";
static const long WIB_GMT_OFFSET_SEC = 7L * 3600L;
static const int CAMPAIGN_DAYS = 42;
static const int START_MINUTE = 7 * 60;
static const int END_MINUTE = 16 * 60 + 50;
static const int INTERVAL_MINUTES = 10;
static const unsigned long WIFI_RETRY_MS = 15000UL;
static const unsigned long SCHEDULE_CHECK_MS = 1000UL;

// =====================================================
// SERVERS & CONCURRENCY
// =====================================================
// Port 80  : portal Wi-Fi, /capture, /status (WebServer)
// Port 81  : /stream MJPEG (esp_http_server, task terpisah)
WebServer server(80);
static httpd_handle_t streamHttpd = NULL;
static SemaphoreHandle_t cameraMutex = NULL;
static Preferences prefs;

// =====================================================
// RUNTIME STATE
// =====================================================
static bool cameraReady = false;
static bool ntpSynced = false;
static bool wifiCredentialsAvailable = false;
static bool wifiPendingVerify = false;
static String savedSSID = "";
static String savedPassword = "";
static String pendingSSID = "";
static String pendingPassword = "";

static uint32_t capturedCount = 0, uploadedCount = 0, failedCount = 0;
static time_t campaignStartEpoch = 0;
static char confirmedSlotKey[24] = "";
static char attemptedSlotKey[24] = "";
static unsigned long lastWifiRetry = 0, lastScheduleCheck = 0;

static inline bool isWifiConnected() {
  return WiFi.status() == WL_CONNECTED;
}

static uint32_t fnv1a(const uint8_t* data, size_t len) {
  uint32_t h = 2166136261UL;
  for (size_t i = 0; i < len; ++i) {
    h ^= data[i];
    h *= 16777619UL;
  }
  return h;
}

// =====================================================
// CAMERA INITIALIZATION (WITH PSRAM SUPPORT)
// =====================================================
static bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;
  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;
  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;
  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;
  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.grab_mode = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    c.frame_size = FRAMESIZE_SVGA;
    c.jpeg_quality = 12;
    c.fb_count = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    c.frame_size = FRAMESIZE_VGA;
    c.jpeg_quality = 14;
    c.fb_count = 1;
    c.fb_location = CAMERA_FB_IN_DRAM;
  }

  esp_err_t err = esp_camera_init(&c);
  cameraReady = (err == ESP_OK);
  if (cameraReady) {
    sensor_t* sensor = esp_camera_sensor_get();
    if (sensor) {
      sensor->set_brightness(sensor, 0);
      sensor->set_contrast(sensor, 0);
      sensor->set_saturation(sensor, 0);
    }
    Serial.println("[CAM] Kamera OV2640 berhasil diinisialisasi.");
  } else {
    Serial.printf("[CAM] Inisialisasi kamera gagal: 0x%x\n", err);
  }
  return cameraReady;
}

// =====================================================
// CORS HEADERS
// =====================================================
static void addCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, X-Slot-Key, X-Checksum-FNV1A");
}

// =====================================================
// SETUP PORTAL HTML
// =====================================================
static String portalHTML() {
  return String(R"rawliteral(<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ESP32-CAM Setup</title>
<style>
*{box-sizing:border-box}
body{font-family:Arial,sans-serif;background:#111;color:#fff;margin:0;padding:20px}
.container{max-width:450px;margin:35px auto;background:#222;padding:25px;border-radius:15px}
h1{text-align:center}
p{color:#ccc;line-height:1.5}
label{display:block;margin:16px 0 6px}
input{width:100%;padding:12px;border-radius:8px;border:1px solid #555;background:#333;color:#fff}
button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:8px;background:#fff;color:#111;font-weight:bold;cursor:pointer}
.info{margin-top:20px;padding:15px;background:#333;border-radius:8px;font-size:14px;line-height:1.8}
</style>
</head>
<body>
<div class="container">
<h1>ESP32-CAM</h1>
<p>Konfigurasi jaringan Wi-Fi kamera.</p>
<form action="/save" method="POST">
<label>Nama Wi-Fi (SSID)</label>
<input type="text" name="ssid" maxlength="32" placeholder="Nama Wi-Fi" required>
<label>Password Wi-Fi</label>
<input type="password" name="password" maxlength="64" placeholder="Password Wi-Fi">
<button type="submit">SIMPAN & HUBUNGKAN</button>
</form>
<div class="info">
<b>Hotspot ESP32-CAM</b><br>
SSID: DAUN KERITING<br>
Password: (terbuka / tanpa password)<br>
IP Portal: http://192.168.50.1
</div>
</div>
</body>
</html>)rawliteral");
}

static String connectionHTML(bool success, const String& message) {
  bool connectedNow = isWifiConnected();
  String html = R"rawliteral(<!DOCTYPE html><html lang="id"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">)rawliteral";
  if (success && !connectedNow) {
    html += "<meta http-equiv=\"refresh\" content=\"4;url=/\">";
  }
  html += R"rawliteral(<title>Status Wi-Fi ESP32-CAM</title>
<style>
body{font-family:Arial;background:#111;color:#fff;text-align:center;padding:25px}
.box{max-width:520px;margin:30px auto;background:#222;padding:25px;border-radius:14px}
a{display:block;margin:12px 0;padding:13px;background:#fff;color:#111;text-decoration:none;border-radius:8px;font-weight:bold}
small{color:#bbb}
</style></head><body><div class="box">)rawliteral";

  if (success && connectedNow) {
    String ip = WiFi.localIP().toString();
    html += "<h1>Wi-Fi Terhubung</h1>";
    html += "<p>" + message + "</p>";
    html += "<p>IP kamera pada jaringan router (isi ini di dashboard):</p><h2>";
    html += ip;
    html += "</h2><a href='http://" + ip + ":81/stream'>Buka Live Stream</a>";
    html += "<a href='/capture'>Ambil Foto</a><a href='/status'>Lihat Status JSON</a>";
    html += "<a href='/?setup=1'>Ubah Konfigurasi Wi-Fi</a>";
    html += "<small>Hubungkan laptop/HP ke jaringan router yang sama.</small>";
  } else if (success && !connectedNow) {
    html += "<h1>Menghubungkan Wi-Fi...</h1>";
    html += "<p>" + message + "</p>";
    html += "<a href='/'>Cek Status Koneksi</a>";
    html += "<a href='/?setup=1'>Kembali ke Konfigurasi Wi-Fi</a>";
    html += "<small>Halaman akan memuat ulang otomatis dalam 4 detik.</small>";
  } else {
    html += "<h1>Wi-Fi Gagal</h1>";
    html += "<p>" + message + "</p>";
    html += "<p>Periksa SSID dan password, lalu coba lagi.</p>";
    html += "<a href='/?setup=1'>Kembali ke konfigurasi Wi-Fi</a>";
  }

  html += "</div></body></html>";
  return html;
}

// =====================================================
// PORT 80 HANDLERS
// =====================================================
static void handleRoot() {
  addCorsHeaders();
  if (isWifiConnected() && !server.hasArg("setup")) {
    server.send(200, "text/html; charset=utf-8",
      connectionHTML(true, "ESP32-CAM berhasil terhubung ke Wi-Fi."));
  } else {
    server.send(200, "text/html; charset=utf-8", portalHTML());
  }
}

static bool hasControlChars(const String& s) {
  for (size_t i = 0; i < s.length(); ++i) {
    char c = s.charAt(i);
    if ((uint8_t)c < 0x20 || c == 0x7F) return true;
  }
  return false;
}

static void handleSave() {
  if (!server.hasArg("ssid")) {
    server.send(400, "text/plain; charset=utf-8", "SSID tidak ditemukan.");
    return;
  }
  String ssid = server.arg("ssid");
  String password = server.arg("password");
  ssid.trim();
  if (ssid.length() == 0 || ssid.length() > 32 || password.length() > 64 ||
      hasControlChars(ssid) || hasControlChars(password)) {
    server.send(400, "text/plain; charset=utf-8", "Format SSID atau password tidak valid.");
    return;
  }

  pendingSSID = ssid;
  pendingPassword = password;
  wifiPendingVerify = true;
  wifiCredentialsAvailable = true;

  // Jika belum ada kredensial sebelumnya di NVS, simpan sebagai baseline awal
  if (prefs.getString("ssid", "").length() == 0) {
    savedSSID = ssid;
    savedPassword = password;
    prefs.putString("ssid", savedSSID);
    prefs.putString("password", savedPassword);
  }

  Serial.println("[WIFI] Mencoba kredensial baru secara non-blocking...");
  WiFi.disconnect();
  WiFi.begin(pendingSSID.c_str(), pendingPassword.c_str());
  lastWifiRetry = millis();

  server.send(200, "text/html; charset=utf-8",
    connectionHTML(true, "ESP32-CAM sedang memverifikasi koneksi Wi-Fi. Kredensial lama dipertahankan bila koneksi baru gagal."));
}

static void handleStatus() {
  addCorsHeaders();
  time_t now = time(nullptr);
  int hst = (campaignStartEpoch > 0 && now >= campaignStartEpoch)
              ? (int)((now - campaignStartEpoch) / 86400L) + 1
              : 1;
  bool connected = isWifiConnected();
  String apIp = WiFi.softAPIP().toString();
  String staIp = connected ? WiFi.localIP().toString() : "";
  String rssiStr = connected ? String(WiFi.RSSI()) : "null";

  char json[512];
  snprintf(json, sizeof(json),
    "{\"device\":\"ESP32-CAM\","
    "\"camera_ready\":%s,"
    "\"wifi_connected\":%s,"
    "\"ntp_synced\":%s,"
    "\"captured\":%lu,"
    "\"uploaded\":%lu,"
    "\"failed\":%lu,"
    "\"hst_day\":%d,"
    "\"last_slot\":\"%s\","
    "\"confirmed_slot\":\"%s\","
    "\"attempted_slot\":\"%s\","
    "\"ap_ssid\":\"%s\","
    "\"ap_ip\":\"%s\","
    "\"sta_ip\":\"%s\","
    "\"rssi\":%s,"
    "\"stream_port\":81,"
    "\"stream_endpoint\":\"/stream\"}",
    cameraReady ? "true" : "false",
    connected ? "true" : "false",
    ntpSynced ? "true" : "false",
    (unsigned long)capturedCount,
    (unsigned long)uploadedCount,
    (unsigned long)failedCount,
    hst,
    confirmedSlotKey,
    confirmedSlotKey,
    attemptedSlotKey,
    AP_SSID,
    apIp.c_str(),
    staIp.c_str(),
    rssiStr.c_str()
  );
  server.send(200, "application/json; charset=utf-8", json);
}

static void handleCapture() {
  addCorsHeaders();
  if (!cameraReady) {
    server.send(503, "text/plain; charset=utf-8", "Kamera belum siap.");
    return;
  }

  // Lindungi framebuffer kamera dengan mutex dari task stream port 81
  if (cameraMutex && xSemaphoreTake(cameraMutex, pdMS_TO_TICKS(2000)) == pdTRUE) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      xSemaphoreGive(cameraMutex);
      Serial.println("[CAPTURE] Framebuffer kosong.");
      server.send(500, "text/plain; charset=utf-8", "Gagal mengambil gambar.");
      return;
    }

    if (fb->format != PIXFORMAT_JPEG || fb->len == 0) {
      esp_camera_fb_return(fb);
      xSemaphoreGive(cameraMutex);
      server.send(500, "text/plain; charset=utf-8", "Format gambar tidak valid.");
      return;
    }

    WiFiClient client = server.client();
    server.sendHeader("Content-Disposition", "inline; filename=capture.jpg");
    server.setContentLength(fb->len);
    server.send(200, "image/jpeg", "");

    size_t written = client.write(fb->buf, fb->len);
    size_t expectedLen = fb->len;
    esp_camera_fb_return(fb);
    xSemaphoreGive(cameraMutex);

    if (written != expectedLen) {
      Serial.printf("[CAPTURE] Byte mismatch: written %u of %u\n", (unsigned)written, (unsigned)expectedLen);
    }
  } else {
    server.send(503, "text/plain; charset=utf-8", "Kamera sedang sibuk.");
  }
}

static void handleStreamRedirect() {
  String host = isWifiConnected() ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
  server.sendHeader("Location", "http://" + host + ":81/stream");
  server.send(302, "text/plain", "");
}

// =====================================================
// AUTONOMOUS SCHEDULER & HTTP UPLOAD
// =====================================================
static bool makeSlot(time_t epoch, struct tm &wib, char *slot, size_t n) {
  if (!localtime_r(&epoch, &wib)) return false;
  int mins = wib.tm_hour * 60 + wib.tm_min;
  if (mins < START_MINUTE || mins > END_MINUTE || (wib.tm_min % INTERVAL_MINUTES) != 0) {
    return false;
  }
  int slotMin = (wib.tm_min / INTERVAL_MINUTES) * INTERVAL_MINUTES;
  snprintf(slot, n, "%04d-%02d-%02d_%02d:%02d", wib.tm_year + 1900, wib.tm_mon + 1, wib.tm_mday, wib.tm_hour, slotMin);
  return true;
}

static bool uploadFrame(camera_fb_t *fb, const char *slot, time_t epoch, uint16_t hst) {
  if (WiFi.status() != WL_CONNECTED || !fb || fb->len < 100) return false;
  HTTPClient http;
  http.setTimeout(12000);
  if (!http.begin(RECEIVER_URL)) return false;
  char checksum[9];
  snprintf(checksum, sizeof(checksum), "%08lx", (unsigned long)fnv1a(fb->buf, fb->len));
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Kelompok", "Kelompok 5");
  http.addHeader("X-Slot-Key", slot);
  http.addHeader("X-Captured-At", String((unsigned long long)epoch * 1000ULL));
  http.addHeader("X-HST-Day", String(hst));
  http.addHeader("X-File-Size", String(fb->len));
  http.addHeader("X-Checksum-FNV1A", checksum);
  int code = http.POST(fb->buf, fb->len);
  String response = code > 0 ? http.getString() : "";
  http.end();
  bool hasOk = (response.indexOf("\"ok\":true")>=0 || response.indexOf("\"ok\": true")>=0);
  bool hasConfirmed = (response.indexOf("\"confirmed\":true")>=0 || response.indexOf("\"confirmed\": true")>=0);
  if (code==200 && hasOk && hasConfirmed) {
    uploadedCount++;
    return true;
  }
  Serial.printf("[UPLOAD] Failed HTTP=%d; slot will not be marked confirmed.\n", code);
  return false;
}

static bool captureSlot(const char *slot, time_t epoch, uint16_t hst) {
  if (!cameraReady && !initCamera()) {
    failedCount++;
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[CAPTURE] Wi-Fi offline; capture skipped (no local SD queue).");
    failedCount++;
    return false;
  }

  // Acquire camera mutex to prevent collision with port 81 stream
  if (cameraMutex && xSemaphoreTake(cameraMutex, pdMS_TO_TICKS(3000)) == pdTRUE) {
    digitalWrite(LED_STATUS_GPIO, LOW);
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      digitalWrite(LED_STATUS_GPIO, HIGH);
      xSemaphoreGive(cameraMutex);
      failedCount++;
      return false;
    }
    bool ok = uploadFrame(fb, slot, epoch, hst);
    esp_camera_fb_return(fb);
    digitalWrite(LED_STATUS_GPIO, HIGH);
    xSemaphoreGive(cameraMutex);

    if (ok) {
      capturedCount++;
      strncpy(confirmedSlotKey, slot, sizeof(confirmedSlotKey) - 1);
      confirmedSlotKey[sizeof(confirmedSlotKey) - 1] = '\0';
      prefs.putString("confirmed_slot",confirmedSlotKey);
      prefs.putString("last_slot", confirmedSlotKey);
      Serial.printf("[CAPTURE] Confirmed slot %s (HST %u)\n", slot, hst);
      return true;
    }
  } else {
    Serial.println("[CAPTURE] Gagal mendapatkan mutex kamera.");
  }
  failedCount++;
  return false;
}

// =====================================================
// LIVE STREAM MJPEG (PORT 81 - esp_http_server)
// =====================================================
static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=frame";
static const char* STREAM_BOUNDARY = "\r\n--frame\r\n";
static const char* STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t streamHandler(httpd_req_t *req) {
  if (!cameraReady) {
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Kamera belum siap");
    return ESP_FAIL;
  }

  esp_err_t res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Cache-Control", "no-cache, no-store, must-revalidate");

  char partBuf[80];
  int failedFrames = 0;

  while (true) {
    camera_fb_t *fb = NULL;
    if (cameraMutex && xSemaphoreTake(cameraMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
      fb = esp_camera_fb_get();
      if (!fb) {
        xSemaphoreGive(cameraMutex);
        if (++failedFrames > 20) {
          Serial.println("[STREAM] Kamera gagal memberi frame, stream dihentikan.");
          return ESP_FAIL;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
        continue;
      }
      failedFrames = 0;

      if (fb->format != PIXFORMAT_JPEG || fb->len == 0) {
        esp_camera_fb_return(fb);
        xSemaphoreGive(cameraMutex);
        vTaskDelay(pdMS_TO_TICKS(50));
        continue;
      }

      res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
      if (res == ESP_OK) {
        size_t hlen = snprintf(partBuf, sizeof(partBuf), STREAM_PART, (unsigned)fb->len);
        res = httpd_resp_send_chunk(req, partBuf, hlen);
      }
      if (res == ESP_OK) {
        res = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);
      }
      esp_camera_fb_return(fb);
      xSemaphoreGive(cameraMutex);
    } else {
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    if (res != ESP_OK) break;
    vTaskDelay(pdMS_TO_TICKS(100));
  }
  Serial.println("[STREAM] Client stream terputus.");
  return res;
}

static void startStreamServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 81;
  config.ctrl_port = 32769;
  config.stack_size = 6144;
  config.max_open_sockets = 3;
  config.lru_purge_enable = true;

  httpd_uri_t streamUri;
  memset(&streamUri, 0, sizeof(streamUri));
  streamUri.uri = "/stream";
  streamUri.method = HTTP_GET;
  streamUri.handler = streamHandler;
  streamUri.user_ctx = NULL;

  if (httpd_start(&streamHttpd, &config) == ESP_OK) {
    httpd_register_uri_handler(streamHttpd, &streamUri);
    Serial.println("[STREAM] Server stream aktif pada port 81 (/stream).");
  } else {
    Serial.println("[STREAM] Gagal menjalankan server stream port 81.");
  }
}

// =====================================================
// SETUP AP & ROUTES
// =====================================================
static void startSetupAP() {
  WiFi.mode(WIFI_AP_STA);
  WiFi.setSleep(false);
  WiFi.softAPConfig(AP_IP, AP_GATEWAY, AP_SUBNET);
  bool result = WiFi.softAP(AP_SSID, AP_PASSWORD);
  if (result) {
    Serial.println("[AP] Hotspot DAUN KERITING aktif.");
    Serial.print("[AP] IP Portal: http://");
    Serial.println(WiFi.softAPIP());
  } else {
    Serial.println("[AP] Gagal mengaktifkan hotspot.");
  }
}

static void setupRoutes() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  server.on("/capture", HTTP_GET, handleCapture);
  server.on("/stream", HTTP_GET, handleStreamRedirect);
  server.on("/status", HTTP_GET, handleStatus);

  // Probe redirects untuk deteksi portal Android, Apple iOS, dan Windows
  server.on("/generate_204", HTTP_GET, []() {
    server.sendHeader("Location", "http://192.168.50.1/");
    server.send(302, "text/plain", "");
  });
  server.on("/hotspot-detect.html", HTTP_GET, []() {
    server.sendHeader("Location", "http://192.168.50.1/");
    server.send(302, "text/plain", "");
  });
  server.on("/connecttest.txt", HTTP_GET, []() {
    server.sendHeader("Location", "http://192.168.50.1/");
    server.send(302, "text/plain", "");
  });

  server.on("/status", HTTP_OPTIONS, []() {
    addCorsHeaders();
    server.send(204);
  });
  server.on("/capture", HTTP_OPTIONS, []() {
    addCorsHeaders();
    server.send(204);
  });

  server.onNotFound([]() {
    addCorsHeaders();
    // Jika request GET tidak cocok ke endpoint API, alihkan ke form setup AP
    if (server.method() == HTTP_GET) {
      server.sendHeader("Location", "http://192.168.50.1/");
      server.send(302, "text/plain", "");
      return;
    }
    server.send(404, "application/json; charset=utf-8", "{\"error\":\"Endpoint tidak ditemukan\"}");
  });
}

// =====================================================
// SETUP & LOOP (NON-BLOCKING)
// =====================================================
void setup() {
  Serial.begin(115200);
  pinMode(LED_STATUS_GPIO, OUTPUT);
  digitalWrite(LED_STATUS_GPIO, HIGH);

  cameraMutex = xSemaphoreCreateMutex();

  prefs.begin("selada-cam", false);
  campaignStartEpoch = (time_t)prefs.getULong64("campaign_start", 0);
  String savedConfirmed = prefs.getString("confirmed_slot", "");
  if (savedConfirmed.length() == 0) {
    savedConfirmed = prefs.getString("last_slot", "");
  }
  savedConfirmed.toCharArray(confirmedSlotKey, sizeof(confirmedSlotKey));
  attemptedSlotKey[0] = '\0';

  savedSSID = prefs.getString("ssid", "");
  savedPassword = prefs.getString("password", "");
  if (savedSSID.length() == 0 && strlen(WIFI_SSID_DEFAULT) > 0) {
    savedSSID = String(WIFI_SSID_DEFAULT);
    savedPassword = String(WIFI_PASS_DEFAULT);
  }
  wifiCredentialsAvailable = savedSSID.length() > 0;

  initCamera();
  startSetupAP();

  setupRoutes();
  server.begin();
  Serial.println("[WEB] Web server aktif pada port 80.");

  startStreamServer();

  if (wifiCredentialsAvailable) {
    Serial.println("[WIFI] Menghubungkan ke Wi-Fi: " + savedSSID);
    WiFi.begin(savedSSID.c_str(), savedPassword.c_str());
    lastWifiRetry = millis();
  }

  configTime(WIB_GMT_OFFSET_SEC, 0, NTP_SERVER);
  Serial.println("[CAM] Wi-Fi autonomous AP+STA ready. Stream: :81/stream, Portal: :80");
}

void loop() {
  server.handleClient();

  unsigned long ms = millis();

  if (wifiPendingVerify && isWifiConnected()) {
    wifiPendingVerify = false;
    savedSSID = pendingSSID;
    savedPassword = pendingPassword;
    prefs.putString("ssid", savedSSID);
    prefs.putString("password", savedPassword);
    Serial.println("[WIFI] Kredensial baru terverifikasi & disimpan ke Preferences.");
  }

  // Non-blocking Wi-Fi reconnect
  if (wifiCredentialsAvailable && !isWifiConnected() && (ms - lastWifiRetry >= WIFI_RETRY_MS)) {
    lastWifiRetry = ms;
    if (wifiPendingVerify) {
      wifiPendingVerify = false;
      Serial.println("[WIFI] Koneksi kredensial baru gagal. Kembali ke kredensial tersimpan.");
    }
    Serial.println("[WIFI] Reconnect attempt...");
    WiFi.disconnect();
    WiFi.begin(savedSSID.c_str(), savedPassword.c_str());
  }

  // Non-blocking autonomous scheduler check
  if (ms - lastScheduleCheck >= SCHEDULE_CHECK_MS) {
    lastScheduleCheck = ms;
    time_t now = time(nullptr);
    if (now > 1700000000L) {
      ntpSynced = true;
      if (campaignStartEpoch == 0) {
        campaignStartEpoch = now;
        prefs.putULong64("campaign_start", (uint64_t)campaignStartEpoch);
      }
      struct tm wib = {};
      char slot[24];
      if (isWifiConnected() && makeSlot(now, wib, slot, sizeof(slot))) {
        if (strcmp(slot, confirmedSlotKey) != 0 && strcmp(slot, attemptedSlotKey) != 0) {
          int hst = (int)((now - campaignStartEpoch) / 86400L) + 1;
          if (hst >= 1 && hst <= CAMPAIGN_DAYS) {
            strncpy(attemptedSlotKey, slot, sizeof(attemptedSlotKey) - 1);
            attemptedSlotKey[sizeof(attemptedSlotKey) - 1] = '\0';
            captureSlot(slot, now, (uint16_t)hst);
          }
        }
      }
    }
  }

  yield();
}
