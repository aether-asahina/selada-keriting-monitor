/**
 * ============================================================================
 * SELADA KERITING SMART MONITOR - KELOMPOK 5
 * Node 1: ESP32 Telemetry & Hysteresis Controller Firmware
 * Target MCU: ESP32-WROOM-32DA
 *
 * Architecture Standards (iot-embedded-systems):
 * - 100% Real Physical Telemetry (Zero Dummy, Zero Simulation, Zero Fabrication)
 * - Non-blocking millis() Finite State Machine (Strictly ZERO delay() in loop)
 * - Hardware Debouncing (50ms window, 5-sample median filter on HW-390 ADC1)
 * - Relay Cooldown & Safety Cutoff (Active-LOW GPIO 26, 65%-78% Hysteresis)
 * - SRAM Optimization: F() Flash string literals & fixed stack buffers (snprintf)
 * - Firebase RTDB Endpoint: /kelompok5.json
 * ============================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <DHT.h>
#include <time.h>

// ---------------------- HARDWARE PIN DEFINITIONS ----------------------
#define PIN_DHT22           4     // GPIO 4: Sensor Suhu & Kelembapan Udara DHT22
#define PIN_SOIL_ADC        34    // GPIO 34 (ADC1_CH6): Sensor Tanah Kapasitif HW-390
#define PIN_RELAY_PUMP      26    // GPIO 26: Relay Pompa Irigasi (Aktif-LOW)
#define DHT_TYPE            DHT22

// Relay Active-LOW Logic Constants
#define RELAY_ON_LEVEL      LOW
#define RELAY_OFF_LEVEL     HIGH

// ---------------------- AGRONOMIC & TIMING CONSTANTS ----------------------
#define HYSTERESIS_DRY_PCT  65.0f // Pompa ON jika kelembapan tanah < 65%
#define HYSTERESIS_WET_PCT  78.0f // Pompa OFF jika kelembapan tanah > 78%
#define ADC_DRY_CALIB       3200  // Nilai ADC kering udara (12-bit: 0..4095)
#define ADC_WET_CALIB       1400  // Nilai ADC jenuh air

#define DEBOUNCE_MS         50UL      // 50ms jeda antar sampel ADC debouncing
#define DEBOUNCE_SAMPLES    5         // 5 sampel median filter per siklus
#define TELEMETRY_PERIOD_MS 2000UL    // Interval pengiriman ke /kelompok5 (2 detik)
#define WIFI_RETRY_MS       10000UL   // Interval rekoneksi Wi-Fi non-blocking (10 detik)
#define RELAY_COOLDOWN_MS   5000UL    // Cooldown minimum antar transisi relay (5 detik)
#define PUMP_MAX_ON_MS      120000UL  // Cutoff keamanan maksimum pompa menyala (120 detik)

// ---------------------- NETWORK & FIREBASE RTDB CONFIG ----------------------
static const char WIFI_SSID[]     PROGMEM = "GREENHOUSE_KELOMPOK5_WIFI";
static const char WIFI_PASS[]     PROGMEM = "CHANGE_ME_IN_PRODUCTION";
static const char RTDB_ENDPOINT[] PROGMEM = "https://selada-a9428-default-rtdb.asia-southeast1.firebasedatabase.app/kelompok5.json";
static const char NTP_SERVER[]    PROGMEM = "pool.ntp.org";
static const long GMT_OFFSET_SEC          = 7L * 3600L; // Asia/Jakarta (WIB UTC+7)

// ---------------------- FINITE STATE MACHINE ----------------------
enum NodeState : uint8_t {
  FSM_IDLE = 0,
  FSM_SAMPLE_ADC,
  FSM_READ_DHT,
  FSM_EVAL_HYSTERESIS,
  FSM_PUSH_RTDB,
  FSM_ERROR_RECOVERY
};

static NodeState currentState = FSM_IDLE;
static DHT dht(PIN_DHT22, DHT_TYPE);

// Timing trackers (millis-based, zero delay)
static unsigned long lastCycleMs       = 0;
static unsigned long lastSampleMs      = 0;
static unsigned long lastWifiAttemptMs = 0;
static unsigned long lastRelaySwitchMs = 0;
static unsigned long pumpTurnedOnAtMs  = 0;

// Sensor & Actuator State
static int   adcSamples[DEBOUNCE_SAMPLES];
static uint8_t sampleIdx       = 0;
static float currentTempC      = NAN;
static float currentHumPct     = NAN;
static float currentSoilPct    = NAN;
static bool  pumpCommand       = false;
static bool  relayActualState  = false;
static bool  sensorsValid      = false;

// ---------------------- HELPER FUNCTIONS ----------------------
static float computeMedianSoilPct() {
  int sorted[DEBOUNCE_SAMPLES];
  for (uint8_t i = 0; i < DEBOUNCE_SAMPLES; i++) {
    sorted[i] = adcSamples[i];
  }
  for (uint8_t i = 0; i < DEBOUNCE_SAMPLES - 1; i++) {
    for (uint8_t j = i + 1; j < DEBOUNCE_SAMPLES; j++) {
      if (sorted[j] < sorted[i]) {
        int tmp = sorted[i];
        sorted[i] = sorted[j];
        sorted[j] = tmp;
      }
    }
  }
  int medianAdc = sorted[DEBOUNCE_SAMPLES / 2];
  if (medianAdc <= 0 || medianAdc >= 4095) {
    return NAN; // Sensor terlepas atau short-circuit: jangan mengarang nilai
  }
  float pct = (float)(ADC_DRY_CALIB - medianAdc) * 100.0f / (float)(ADC_DRY_CALIB - ADC_WET_CALIB);
  if (pct < 0.0f) pct = 0.0f;
  if (pct > 100.0f) pct = 100.0f;
  return pct;
}

static void applyRelayState(bool turnOn, unsigned long nowMs) {
  if (turnOn == relayActualState) return;
  if (nowMs - lastRelaySwitchMs < RELAY_COOLDOWN_MS) return;

  digitalWrite(PIN_RELAY_PUMP, turnOn ? RELAY_ON_LEVEL : RELAY_OFF_LEVEL);
  // Baca kembali level pin fisik sebagai konfirmasi relayActual
  relayActualState = (digitalRead(PIN_RELAY_PUMP) == RELAY_ON_LEVEL);
  lastRelaySwitchMs = nowMs;
  if (relayActualState) {
    pumpTurnedOnAtMs = nowMs;
  }
}

static void formatWibTimestamp(char* outBuf, size_t outLen, unsigned long long* epochMsOut) {
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 10)) {
    time_t nowSec = mktime(&timeinfo);
    *epochMsOut = (unsigned long long)nowSec * 1000ULL;
    snprintf(outBuf, outLen, "%04d-%02d-%02d %02d:%02d:%02d",
             timeinfo.tm_year + 1900, timeinfo.tm_mon + 1, timeinfo.tm_mday,
             timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
  } else {
    *epochMsOut = 0ULL;
    snprintf(outBuf, outLen, "UNSYNCED_RTC");
  }
}

// ---------------------- SETUP ----------------------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_RELAY_PUMP, OUTPUT);
  digitalWrite(PIN_RELAY_PUMP, RELAY_OFF_LEVEL);
  relayActualState = false;

  analogReadResolution(12);
  dht.begin();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  configTime(GMT_OFFSET_SEC, 0, NTP_SERVER);

  Serial.println(F("[KELOMPOK-5] ESP32 Telemetry & Hysteresis Node Initialized (Zero-Delay FSM)"));
}

// ---------------------- NON-BLOCKING MAIN LOOP ----------------------
void loop() {
  const unsigned long nowMs = millis();

  // 1. Non-blocking Wi-Fi Auto-Reconnect
  if (WiFi.status() != WL_CONNECTED) {
    if (nowMs - lastWifiAttemptMs >= WIFI_RETRY_MS) {
      lastWifiAttemptMs = nowMs;
      Serial.println(F("[KELOMPOK-5] WiFi disconnected. Triggering non-blocking reconnect..."));
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
  }

  // 2. Safety Cutoff Guard: Matikan pompa jika menyala melebihi batas 120 detik
  if (relayActualState && (nowMs - pumpTurnedOnAtMs >= PUMP_MAX_ON_MS)) {
    Serial.println(F("[KELOMPOK-5] SAFETY CUTOFF: Pump exceeded 120s max runtime. Forcing OFF."));
    pumpCommand = false;
    applyRelayState(false, nowMs);
  }

  // 3. Finite State Machine Execution
  switch (currentState) {
    case FSM_IDLE: {
      if (nowMs - lastCycleMs >= TELEMETRY_PERIOD_MS) {
        lastCycleMs = nowMs;
        sampleIdx = 0;
        lastSampleMs = nowMs;
        currentState = FSM_SAMPLE_ADC;
      }
      break;
    }

    case FSM_SAMPLE_ADC: {
      if (nowMs - lastSampleMs >= DEBOUNCE_MS) {
        lastSampleMs = nowMs;
        adcSamples[sampleIdx++] = analogRead(PIN_SOIL_ADC);
        if (sampleIdx >= DEBOUNCE_SAMPLES) {
          currentSoilPct = computeMedianSoilPct();
          currentState = FSM_READ_DHT;
        }
      }
      break;
    }

    case FSM_READ_DHT: {
      float t = dht.readTemperature();
      float h = dht.readHumidity();

      if (isnan(t) || isnan(h) || isnan(currentSoilPct) ||
          t < 0.0f || t > 55.0f || h < 5.0f || h > 100.0f) {
        sensorsValid = false;
        currentState = FSM_ERROR_RECOVERY;
      } else {
        currentTempC = t;
        currentHumPct = h;
        sensorsValid = true;
        currentState = FSM_EVAL_HYSTERESIS;
      }
      break;
    }

    case FSM_EVAL_HYSTERESIS: {
      if (currentSoilPct < HYSTERESIS_DRY_PCT) {
        pumpCommand = true;
      } else if (currentSoilPct > HYSTERESIS_WET_PCT) {
        pumpCommand = false;
      }
      applyRelayState(pumpCommand, nowMs);
      currentState = FSM_PUSH_RTDB;
      break;
    }

    case FSM_PUSH_RTDB: {
      if (WiFi.status() == WL_CONNECTED && sensorsValid) {
        char timeStr[24];
        unsigned long long epochMs = 0ULL;
        formatWibTimestamp(timeStr, sizeof(timeStr), &epochMs);

        const char* statusZone = (currentSoilPct < HYSTERESIS_DRY_PCT)
          ? "Kering"
          : ((currentSoilPct > HYSTERESIS_WET_PCT) ? "Basah" : "Optimal");

        char payload[280];
        snprintf(payload, sizeof(payload),
                 "{\"kelompok\":\"Kelompok 5\",\"suhu\":%.1f,\"kelembapan_udara\":%.0f,"
                 "\"kelembapan_tanah\":%.0f,\"status\":\"%s\",\"pompa\":%s,\"relay\":%s,"
                 "\"timestamp\":%llu,\"waktu_wib\":\"%s\"}",
                 currentTempC,
                 currentHumPct,
                 currentSoilPct,
                 statusZone,
                 pumpCommand ? "true" : "false",
                 relayActualState ? "true" : "false",
                 epochMs,
                 timeStr);

        WiFiClientSecure client;
        client.setInsecure();
        HTTPClient http;
        http.setTimeout(3500);
        if (http.begin(client, RTDB_ENDPOINT)) {
          http.addHeader(F("Content-Type"), F("application/json"));
          int code = http.POST((uint8_t*)payload, strlen(payload));
          if (code >= 200 && code < 300) {
            Serial.println(F("[KELOMPOK-5] Telemetry pushed to /kelompok5 successfully."));
          } else {
            Serial.print(F("[KELOMPOK-5] RTDB HTTP Error: "));
            Serial.println(code);
          }
          http.end();
        }
      }
      currentState = FSM_IDLE;
      break;
    }

    case FSM_ERROR_RECOVERY: {
      // Sensor fisik gagal dibaca: matikan pompa demi keamanan dan JANGAN kirim angka palsu
      Serial.println(F("[KELOMPOK-5] SENSOR FAULT: Physical sensor invalid/disconnected. Skipping RTDB push (Zero-Dummy Policy)."));
      pumpCommand = false;
      applyRelayState(false, nowMs);
      currentState = FSM_IDLE;
      break;
    }
  }
}
