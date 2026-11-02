/**
 * ============================================================================
 * SELADA KERITING SMART MONITOR - KELOMPOK 5
 * Node 2: ESP32-CAM Autonomous 42-Day Scheduler, microSD Spooler & Sync Engine
 * Target MCU: AI-Thinker ESP32-CAM (OV2640 + PSRAM + microSD SD_MMC 1-Bit)
 *
 * Key Capabilities Implemented:
 * 1. Local IP Live Stream preserved at "/stream" (Port 81) + "/capture" & "/status" (Port 80).
 * 2. Autonomous 10-Minute Capture Scheduler (07:00-16:50 WIB, 42 Days = 2,520 slots)
 *    operating independently of Wi-Fi and saving directly to microSD (/kelompok5/queue/).
 * 3. Store-and-Forward Deferred Sync: When Wi-Fi & sync server are reachable,
 *    uploads 1 unsent photo per cycle and deletes local queue file ONLY after
 *    validated HTTP 200 + JSON confirmation receipt from server.
 * 4. RAM Optimization: Processes strictly 1 frame per cycle in PSRAM, frees
 *    camera_fb_t immediately after SD write, streams file in 2KB stack chunks.
 * 5. Fault Tolerance: Handles reboot recovery (/kelompok5/state.json), camera error
 *    soft-reset, microSD full guard, and non-blocking Wi-Fi auto-reconnect.
 * 6. 100% Real Physical Data Only (Zero Dummy, Zero Synthetic Images).
 * ============================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#include "FS.h"
#include "SD_MMC.h"
#include <time.h>

// ---------------------- AI-THINKER ESP32-CAM PINOUT ----------------------
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
#define LED_STATUS_GPIO   33 // Active-LOW onboard red status LED

// ---------------------- CAMPAIGN & STORAGE CONSTANTS ----------------------
#define CAMPAIGN_TOTAL_DAYS       42
#define WINDOW_START_MINUTE       420   // 07:00 WIB = 7 * 60
#define WINDOW_END_MINUTE         1010  // 16:50 WIB = 16 * 60 + 50
#define CAPTURE_INTERVAL_MIN      10    // Every 10 minutes
#define MIN_SD_FREE_BYTES         (4ULL * 1024ULL * 1024ULL) // 4 MB safety reserve
#define IO_CHUNK_SIZE             2048  // 2 KB stack buffer for RAM-safe streaming

#define SCHED_CHECK_PERIOD_MS     5000UL  // Check schedule every 5s
#define SYNC_CYCLE_PERIOD_MS      15000UL // Sync 1 queued file every 15s when online
#define WIFI_RECONNECT_PERIOD_MS  10000UL // Non-blocking Wi-Fi retry every 10s
#define RTC_CHECKPOINT_PERIOD_MS  60000UL // Persist RTC epoch to SD every 60s

// ---------------------- NETWORK & SYNC ENDPOINT CONFIG ----------------------
static const char WIFI_SSID[]         PROGMEM = "GREENHOUSE_KELOMPOK5_WIFI";
static const char WIFI_PASS[]         PROGMEM = "CHANGE_ME_IN_PRODUCTION";
static const char SYNC_SERVER_URL[]   PROGMEM = "http://192.168.1.100:8081/api/kelompok5/sync";
static const char NTP_SERVER[]        PROGMEM = "pool.ntp.org";
static const long WIB_GMT_OFFSET_SEC          = 7L * 3600L; // Asia/Jakarta (UTC+7)

// SD Paths
static const char SD_DIR_ROOT[]       PROGMEM = "/kelompok5";
static const char SD_DIR_QUEUE[]      PROGMEM = "/kelompok5/queue";
static const char SD_STATE_FILE[]     PROGMEM = "/kelompok5/state.json";
static const char SD_AUDIT_LOG[]      PROGMEM = "/kelompok5/audit.log";

// ---------------------- RUNTIME STATE ----------------------
enum CamFsmState : uint8_t {
  CAM_FSM_IDLE = 0,
  CAM_FSM_CHECK_SCHEDULE,
  CAM_FSM_CAPTURE_TO_SD,
  CAM_FSM_SYNC_ONE_PHOTO,
  CAM_FSM_WIFI_RECONNECT
};

static CamFsmState fsmState = CAM_FSM_IDLE;

static bool          cameraReady        = false;
static bool          sdMounted          = false;
static bool          sdFull             = false;
static bool          ntpSynced          = false;
static time_t        bootBaseEpoch      = 0;
static unsigned long bootBaseMillis     = 0;
static time_t        campaignStartEpoch = 0;

static uint32_t totalCapturedCount = 0;
static uint32_t totalSyncedCount   = 0;
static uint32_t totalFailedCount   = 0;
static uint32_t pendingQueueCount  = 0;
static uint8_t  consecutiveCamErr  = 0;
static char     lastSlotKey[24]    = "";
static char     currentSlotKey[24] = "";

static unsigned long lastSchedCheckMs  = 0;
static unsigned long lastSyncCycleMs   = 0;
static unsigned long lastWifiRetryMs   = 0;
static unsigned long lastRtcSaveMs     = 0;

static httpd_handle_t controlHttpd = NULL;
static httpd_handle_t streamHttpd  = NULL;

// ---------------------- FNV-1a 32-BIT CHECKSUM ----------------------
static uint32_t computeFnv1a(const uint8_t* data, size_t len, uint32_t hash = 2166136261UL) {
  for (size_t i = 0; i < len; i++) {
    hash ^= data[i];
    hash *= 16777619UL;
  }
  return hash;
}

// ---------------------- TIME & RECOVERY MANAGEMENT ----------------------
static time_t getReliableEpoch() {
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 5)) {
    time_t nowEpoch = mktime(&timeinfo);
    if (nowEpoch > 1700000000L) {
      ntpSynced = true;
      bootBaseEpoch = nowEpoch;
      bootBaseMillis = millis();
      return nowEpoch;
    }
  }
  // Fallback to persisted RTC checkpoint + monotonic millis() when offline
  if (bootBaseEpoch > 1700000000L) {
    unsigned long elapsedSec = (millis() - bootBaseMillis) / 1000UL;
    return bootBaseEpoch + (time_t)elapsedSec;
  }
  return 0;
}

static uint16_t computeHstDay(time_t nowEpoch) {
  if (campaignStartEpoch <= 0 || nowEpoch < campaignStartEpoch) return 1;
  uint16_t day = (uint16_t)((nowEpoch - campaignStartEpoch) / 86400L) + 1;
  if (day > CAMPAIGN_TOTAL_DAYS) day = CAMPAIGN_TOTAL_DAYS;
  return day;
}

static void savePersistentState() {
  if (!sdMounted) return;
  File f = SD_MMC.open(SD_STATE_FILE, FILE_WRITE);
  if (!f) return;

  time_t nowEpoch = getReliableEpoch();
  char buf[320];
  snprintf(buf, sizeof(buf),
           "{\"kelompok\":\"Kelompok 5\",\"last_epoch\":%ld,\"campaign_start\":%ld,"
           "\"last_slot\":\"%s\",\"captured\":%lu,\"synced\":%lu,\"failed\":%lu,\"pending\":%lu}",
           (long)nowEpoch, (long)campaignStartEpoch, lastSlotKey,
           (unsigned long)totalCapturedCount, (unsigned long)totalSyncedCount,
           (unsigned long)totalFailedCount, (unsigned long)pendingQueueCount);
  f.print(buf);
  f.close();
}

static void loadPersistentState() {
  if (!sdMounted || !SD_MMC.exists(SD_STATE_FILE)) return;
  File f = SD_MMC.open(SD_STATE_FILE, FILE_READ);
  if (!f) return;

  char buf[320];
  size_t n = f.readBytes(buf, sizeof(buf) - 1);
  buf[n] = '\0';
  f.close();

  // Lightweight stack parser for recovery state
  char* pEpoch = strstr(buf, "\"last_epoch\":");
  if (pEpoch) {
    bootBaseEpoch = (time_t)atol(pEpoch + 13);
    bootBaseMillis = millis();
  }
  char* pStart = strstr(buf, "\"campaign_start\":");
  if (pStart) campaignStartEpoch = (time_t)atol(pStart + 17);

  char* pSlot = strstr(buf, "\"last_slot\":\"");
  if (pSlot) {
    pSlot += 13;
    size_t i = 0;
    while (pSlot[i] && pSlot[i] != '"' && i < sizeof(lastSlotKey) - 1) {
      lastSlotKey[i] = pSlot[i];
      i++;
    }
    lastSlotKey[i] = '\0';
  }
  char* pCap = strstr(buf, "\"captured\":");
  if (pCap) totalCapturedCount = (uint32_t)strtoul(pCap + 11, NULL, 10);
  char* pSyn = strstr(buf, "\"synced\":");
  if (pSyn) totalSyncedCount = (uint32_t)strtoul(pSyn + 9, NULL, 10);
  char* pFail = strstr(buf, "\"failed\":");
  if (pFail) totalFailedCount = (uint32_t)strtoul(pFail + 9, NULL, 10);
}

static void refreshQueueCount() {
  if (!sdMounted) { pendingQueueCount = 0; return; }
  File dir = SD_MMC.open(SD_DIR_QUEUE);
  if (!dir || !dir.isDirectory()) { pendingQueueCount = 0; return; }

  uint32_t cnt = 0;
  File entry = dir.openNextFile();
  while (entry) {
    const char* name = entry.name();
    size_t len = strlen(name);
    if (!entry.isDirectory() && len > 4 && strcmp(name + len - 4, ".jpg") == 0) {
      cnt++;
    }
    entry.close();
    entry = dir.openNextFile();
  }
  dir.close();
  pendingQueueCount = cnt;
}

// ---------------------- CAMERA & SD INITIALIZATION ----------------------
static bool initCameraHardware() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode    = CAMERA_GRAB_LATEST;

  // RAM Optimization: Use strictly 1 frame buffer in PSRAM to minimize heap pressure
  if (psramFound()) {
    config.frame_size   = FRAMESIZE_SVGA; // 800x600 optimal for CV contour segmentation
    config.jpeg_quality = 12;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_PSRAM;
  } else {
    config.frame_size   = FRAMESIZE_VGA;
    config.jpeg_quality = 14;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_DRAM;
  }

  esp_err_t err = esp_camera_init(&config);
  cameraReady = (err == ESP_OK);
  return cameraReady;
}

static bool initMicroSD() {
  // Use 1-bit mode so GPIO 4 flash LED is not pulsed during SD writes
  if (!SD_MMC.begin("/sdcard", true)) {
    sdMounted = false;
    return false;
  }
  if (SD_MMC.cardType() == CARD_NONE) {
    sdMounted = false;
    return false;
  }
  sdMounted = true;
  if (!SD_MMC.exists(SD_DIR_ROOT))  SD_MMC.mkdir(SD_DIR_ROOT);
  if (!SD_MMC.exists(SD_DIR_QUEUE)) SD_MMC.mkdir(SD_DIR_QUEUE);
  return true;
}

// ---------------------- AUTONOMOUS CAPTURE TO MICROSD ----------------------
static void capturePhotoToMicroSD(const char* slotKey) {
  if (!sdMounted && !initMicroSD()) {
    totalFailedCount++;
    Serial.println(F("[KELOMPOK-5 CAM] SD_ERR: microSD not mounted. Cannot store offline capture."));
    return;
  }

  uint64_t totalB = SD_MMC.totalBytes();
  uint64_t usedB  = SD_MMC.usedBytes();
  if (totalB <= usedB || (totalB - usedB) < MIN_SD_FREE_BYTES) {
    sdFull = true;
    totalFailedCount++;
    Serial.println(F("[KELOMPOK-5 CAM] SD_FULL: Free space below 4MB reserve. Capture aborted safely."));
    savePersistentState();
    return;
  }
  sdFull = false;

  if (!cameraReady && !initCameraHardware()) {
    totalFailedCount++;
    savePersistentState();
    return;
  }

  // Capture single frame in PSRAM
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb || fb->len < 1024) {
    if (fb) esp_camera_fb_return(fb);
    totalFailedCount++;
    consecutiveCamErr++;
    Serial.println(F("[KELOMPOK-5 CAM] CAM_ERR: Frame capture failed or corrupted."));
    if (consecutiveCamErr >= 3) {
      esp_camera_deinit();
      initCameraHardware();
      consecutiveCamErr = 0;
    }
    savePersistentState();
    return;
  }
  consecutiveCamErr = 0;

  time_t nowEpoch = getReliableEpoch();
  if (campaignStartEpoch <= 0 && nowEpoch > 1700000000L) {
    campaignStartEpoch = nowEpoch;
  }
  uint16_t hstDay = computeHstDay(nowEpoch);
  struct tm tminfo;
  gmtime_r(&nowEpoch, &tminfo);

  uint32_t checksum = computeFnv1a(fb->buf, fb->len);
  size_t   frameLen = fb->len;

  // Unique deterministic filename: K5_HSTxx_YYYYMMDD_HHMMSS_ms.jpg
  char jpgPath[96];
  char metaPath[96];
  snprintf(jpgPath, sizeof(jpgPath),
           "/kelompok5/queue/K5_HST%02u_%04d%02d%02d_%02d%02d%02d_%lu.jpg",
           hstDay,
           tminfo.tm_year + 1900, tminfo.tm_mon + 1, tminfo.tm_mday,
           tminfo.tm_hour, tminfo.tm_min, tminfo.tm_sec,
           millis() % 1000UL);
  snprintf(metaPath, sizeof(metaPath), "%s.meta", jpgPath);

  File imgFile = SD_MMC.open(jpgPath, FILE_WRITE);
  bool writeOk = false;
  if (imgFile) {
    size_t written = imgFile.write(fb->buf, fb->len);
    imgFile.flush();
    imgFile.close();
    writeOk = (written == fb->len);
  }

  // Immediately release PSRAM frame buffer before writing metadata
  esp_camera_fb_return(fb);
  fb = NULL;

  if (!writeOk) {
    SD_MMC.remove(jpgPath);
    totalFailedCount++;
    Serial.println(F("[KELOMPOK-5 CAM] SD_WRITE_ERR: Incomplete JPEG write removed."));
    savePersistentState();
    return;
  }

  // Write companion metadata file for deferred sync verification
  File metaFile = SD_MMC.open(metaPath, FILE_WRITE);
  if (metaFile) {
    char metaJson[256];
    snprintf(metaJson, sizeof(metaJson),
             "{\"kelompok\":\"Kelompok 5\",\"slot_key\":\"%s\",\"captured_at\":%ld000,"
             "\"hst_day\":%u,\"file_size\":%u,\"fnv1a\":\"%08lx\"}",
             slotKey, (long)nowEpoch, hstDay, (unsigned int)frameLen, (unsigned long)checksum);
    metaFile.print(metaJson);
    metaFile.close();
  }

  strncpy(lastSlotKey, slotKey, sizeof(lastSlotKey) - 1);
  totalCapturedCount++;
  pendingQueueCount++;
  savePersistentState();

  Serial.print(F("[KELOMPOK-5 CAM] Stored offline capture to microSD: "));
  Serial.println(jpgPath);
}

// ---------------------- DEFERRED SYNC (1 PHOTO PER CYCLE) ----------------------
static void syncOneQueuedPhoto() {
  if (WiFi.status() != WL_CONNECTED || !sdMounted) return;

  File dir = SD_MMC.open(SD_DIR_QUEUE);
  if (!dir || !dir.isDirectory()) return;

  char targetJpgPath[96] = "";
  size_t targetSize = 0;

  File entry = dir.openNextFile();
  while (entry) {
    const char* name = entry.name();
    size_t len = strlen(name);
    if (!entry.isDirectory() && len > 4 && strcmp(name + len - 4, ".jpg") == 0) {
      if (name[0] == '/') {
        strncpy(targetJpgPath, name, sizeof(targetJpgPath) - 1);
      } else {
        snprintf(targetJpgPath, sizeof(targetJpgPath), "/kelompok5/queue/%s", name);
      }
      targetSize = entry.size();
      entry.close();
      break;
    }
    entry.close();
    entry = dir.openNextFile();
  }
  dir.close();

  if (targetJpgPath[0] == '\0' || targetSize < 1024) return;

  // Compute FNV-1a checksum over 2KB chunks without loading entire image into RAM
  File fCheck = SD_MMC.open(targetJpgPath, FILE_READ);
  if (!fCheck) return;
  uint8_t chunk[IO_CHUNK_SIZE];
  uint32_t fnvHash = 2166136261UL;
  while (fCheck.available()) {
    size_t n = fCheck.read(chunk, sizeof(chunk));
    fnvHash = computeFnv1a(chunk, n, fnvHash);
  }
  fCheck.close();

  char checksumHex[12];
  snprintf(checksumHex, sizeof(checksumHex), "%08lx", (unsigned long)fnvHash);

  File fUpload = SD_MMC.open(targetJpgPath, FILE_READ);
  if (!fUpload) return;

  HTTPClient http;
  http.setTimeout(8000);
  if (http.begin(SYNC_SERVER_URL)) {
    http.addHeader(F("Content-Type"), F("image/jpeg"));
    http.addHeader(F("X-Kelompok"), F("Kelompok 5"));
    http.addHeader(F("X-File-Path"), targetJpgPath);
    http.addHeader(F("X-File-Size"), String((unsigned int)targetSize));
    http.addHeader(F("X-Checksum-FNV1A"), checksumHex);

    int httpCode = http.sendRequest("POST", &fUpload, targetSize);
    fUpload.close();

    if (httpCode == 200) {
      String resp = http.getString();
      // STRICT VALIDATION GATE: Only delete local file if server explicitly confirms receipt
      if (resp.indexOf("\"confirmed\":true") >= 0 && resp.indexOf("\"ok\":true") >= 0) {
        SD_MMC.remove(targetJpgPath);
        char metaPath[104];
        snprintf(metaPath, sizeof(metaPath), "%s.meta", targetJpgPath);
        if (SD_MMC.exists(metaPath)) SD_MMC.remove(metaPath);

        totalSyncedCount++;
        refreshQueueCount();
        savePersistentState();
        Serial.print(F("[KELOMPOK-5 SYNC] Confirmed & removed from SD queue: "));
        Serial.println(targetJpgPath);
      } else {
        Serial.println(F("[KELOMPOK-5 SYNC] Server response missing confirmation token. Retaining local SD file."));
      }
    } else {
      Serial.print(F("[KELOMPOK-5 SYNC] Upload deferred (HTTP "));
      Serial.print(httpCode);
      Serial.println(F("). File preserved on microSD."));
    }
    http.end();
  } else {
    fUpload.close();
  }
}

// ---------------------- HTTP ENDPOINTS (/stream, /capture, /status) ----------------------
static esp_err_t streamHandler(httpd_req_t* req) {
  camera_fb_t* fb = NULL;
  esp_err_t res = ESP_OK;
  char partBuf[64];

  httpd_resp_set_type(req, "multipart/x-mixed-replace;boundary=frame");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) {
      res = ESP_FAIL;
      break;
    }
    int hlen = snprintf(partBuf, sizeof(partBuf),
                        "\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n",
                        (unsigned int)fb->len);
    res = httpd_resp_send_chunk(req, partBuf, hlen);
    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);
    }
    esp_camera_fb_return(fb);
    fb = NULL;
    if (res != ESP_OK) break;
  }
  return res;
}

static esp_err_t captureHandler(httpd_req_t* req) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t res = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

static esp_err_t statusHandler(httpd_req_t* req) {
  uint64_t freeMb = 0;
  uint64_t totalMb = 0;
  if (sdMounted) {
    totalMb = SD_MMC.totalBytes() / (1024ULL * 1024ULL);
    uint64_t usedMb = SD_MMC.usedBytes() / (1024ULL * 1024ULL);
    freeMb = (totalMb > usedMb) ? (totalMb - usedMb) : 0;
  }
  time_t nowEpoch = getReliableEpoch();
  uint16_t hstDay = computeHstDay(nowEpoch);

  char json[384];
  snprintf(json, sizeof(json),
           "{\"kelompok\":\"Kelompok 5\",\"camera_ready\":%s,\"sd_mounted\":%s,\"sd_full\":%s,"
           "\"sd_free_mb\":%llu,\"sd_total_mb\":%llu,\"ntp_synced\":%s,\"hst_day\":%u,"
           "\"captured\":%lu,\"synced\":%lu,\"failed\":%lu,\"pending_queue\":%lu,"
           "\"last_slot\":\"%s\",\"stream_endpoint\":\"/stream\"}",
           cameraReady ? "true" : "false",
           sdMounted ? "true" : "false",
           sdFull ? "true" : "false",
           freeMb, totalMb,
           ntpSynced ? "true" : "false",
           hstDay,
           (unsigned long)totalCapturedCount,
           (unsigned long)totalSyncedCount,
           (unsigned long)totalFailedCount,
           (unsigned long)pendingQueueCount,
           lastSlotKey);

  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, json, strlen(json));
}

static void startCameraHttpServers() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;

  httpd_uri_t captureUri = { .uri = "/capture", .method = HTTP_GET, .handler = captureHandler, .user_ctx = NULL };
  httpd_uri_t statusUri  = { .uri = "/status",  .method = HTTP_GET, .handler = statusHandler,  .user_ctx = NULL };

  if (httpd_start(&controlHttpd, &config) == ESP_OK) {
    httpd_register_uri_handler(controlHttpd, &captureUri);
    httpd_register_uri_handler(controlHttpd, &statusUri);
  }

  config.server_port = 81;
  config.ctrl_port   = 32769;
  httpd_uri_t streamUri = { .uri = "/stream", .method = HTTP_GET, .handler = streamHandler, .user_ctx = NULL };
  if (httpd_start(&streamHttpd, &config) == ESP_OK) {
    httpd_register_uri_handler(streamHttpd, &streamUri);
  }
}

// ---------------------- SETUP & NON-BLOCKING LOOP ----------------------
void setup() {
  Serial.begin(115200);
  pinMode(LED_STATUS_GPIO, OUTPUT);
  digitalWrite(LED_STATUS_GPIO, HIGH);

  initCameraHardware();
  initMicroSD();
  loadPersistentState();
  refreshQueueCount();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  configTime(WIB_GMT_OFFSET_SEC, 0, NTP_SERVER);

  startCameraHttpServers();
  Serial.println(F("[KELOMPOK-5 CAM] Autonomous ESP32-CAM Node Operational (/stream on :81, SD Spooler Ready)"));
}

void loop() {
  const unsigned long nowMs = millis();

  // Periodic RTC checkpoint to microSD for offline power-loss recovery
  if (nowMs - lastRtcSaveMs >= RTC_CHECKPOINT_PERIOD_MS) {
    lastRtcSaveMs = nowMs;
    savePersistentState();
  }

  switch (fsmState) {
    case CAM_FSM_IDLE: {
      if (nowMs - lastSchedCheckMs >= SCHED_CHECK_PERIOD_MS) {
        lastSchedCheckMs = nowMs;
        fsmState = CAM_FSM_CHECK_SCHEDULE;
      } else if (nowMs - lastSyncCycleMs >= SYNC_CYCLE_PERIOD_MS) {
        lastSyncCycleMs = nowMs;
        fsmState = CAM_FSM_SYNC_ONE_PHOTO;
      } else if (WiFi.status() != WL_CONNECTED && (nowMs - lastWifiRetryMs >= WIFI_RECONNECT_PERIOD_MS)) {
        lastWifiRetryMs = nowMs;
        fsmState = CAM_FSM_WIFI_RECONNECT;
      }
      break;
    }

    case CAM_FSM_CHECK_SCHEDULE: {
      time_t nowEpoch = getReliableEpoch();
      if (nowEpoch > 1700000000L) {
        struct tm wib;
        gmtime_r(&nowEpoch, &wib); // Already offset by WIB_GMT_OFFSET_SEC via configTime
        int mins = wib.tm_hour * 60 + wib.tm_min;
        uint16_t hstDay = computeHstDay(nowEpoch);

        if (hstDay <= CAMPAIGN_TOTAL_DAYS &&
            mins >= WINDOW_START_MINUTE && mins <= WINDOW_END_MINUTE &&
            (wib.tm_min % CAPTURE_INTERVAL_MIN == 0)) {
          int slotMin = (wib.tm_min / CAPTURE_INTERVAL_MIN) * CAPTURE_INTERVAL_MIN;
          snprintf(currentSlotKey, sizeof(currentSlotKey), "%04d-%02d-%02d_%02d:%02d",
                   wib.tm_year + 1900, wib.tm_mon + 1, wib.tm_mday, wib.tm_hour, slotMin);

          if (strcmp(currentSlotKey, lastSlotKey) != 0) {
            fsmState = CAM_FSM_CAPTURE_TO_SD;
            break;
          }
        }
      }
      fsmState = CAM_FSM_IDLE;
      break;
    }

    case CAM_FSM_CAPTURE_TO_SD: {
      digitalWrite(LED_STATUS_GPIO, LOW);
      capturePhotoToMicroSD(currentSlotKey);
      digitalWrite(LED_STATUS_GPIO, HIGH);
      fsmState = CAM_FSM_IDLE;
      break;
    }

    case CAM_FSM_SYNC_ONE_PHOTO: {
      if (pendingQueueCount > 0 && WiFi.status() == WL_CONNECTED) {
        syncOneQueuedPhoto();
      }
      fsmState = CAM_FSM_IDLE;
      break;
    }

    case CAM_FSM_WIFI_RECONNECT: {
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      fsmState = CAM_FSM_IDLE;
      break;
    }
  }
}
