/**
 * SELADA KERITING MONITOR - ESP32-CAM AUTONOMOUS WIFI CAPTURE
 * AI-Thinker ESP32-CAM / OV2640. No microSD hardware or synchronization.
 * Camera is the ONLY capture scheduler: every 10 minutes, 07:00-16:50 WIB.
 * JPEG is POSTed directly to the Python receiver over Wi-Fi.
 * Live stream remains available at http://CAMERA_IP:81/stream.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#include <time.h>

#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22
#define LED_STATUS_GPIO 33

static const char WIFI_SSID[] = "KELOMPOK5_SMART_MONITOR_WIFI";
static const char WIFI_PASS[] = "CHANGE_ME_IN_PRODUCTION";
// Set this to the computer/server running scripts/scheduler_daemon.py --receiver.
static const char RECEIVER_URL[] = "http://192.168.1.100:8081/api/kelompok5/capture";
static const char NTP_SERVER[] = "pool.ntp.org";
static const long WIB_GMT_OFFSET_SEC = 7L * 3600L;
static const int CAMPAIGN_DAYS = 42;
static const int START_MINUTE = 7 * 60;
static const int END_MINUTE = 16 * 60 + 50;
static const int INTERVAL_MINUTES = 10;
static const unsigned long WIFI_RETRY_MS = 10000UL;
static const unsigned long SCHEDULE_CHECK_MS = 1000UL;

static bool cameraReady = false;
static bool ntpSynced = false;
static uint32_t capturedCount = 0, uploadedCount = 0, failedCount = 0;
static time_t campaignStartEpoch = 0;
static char confirmedSlotKey[24] = "";
static char attemptedSlotKey[24] = "";
static unsigned long lastWifiRetry = 0, lastScheduleCheck = 0;
static httpd_handle_t controlHttpd = NULL, streamHttpd = NULL;
static Preferences prefs;

static uint32_t fnv1a(const uint8_t* data, size_t len) {
  uint32_t h = 2166136261UL;
  for (size_t i=0; i<len; ++i) { h ^= data[i]; h *= 16777619UL; }
  return h;
}

static bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel=LEDC_CHANNEL_0; c.ledc_timer=LEDC_TIMER_0;
  c.pin_d0=Y2_GPIO_NUM; c.pin_d1=Y3_GPIO_NUM; c.pin_d2=Y4_GPIO_NUM; c.pin_d3=Y5_GPIO_NUM;
  c.pin_d4=Y6_GPIO_NUM; c.pin_d5=Y7_GPIO_NUM; c.pin_d6=Y8_GPIO_NUM; c.pin_d7=Y9_GPIO_NUM;
  c.pin_xclk=XCLK_GPIO_NUM; c.pin_pclk=PCLK_GPIO_NUM; c.pin_vsync=VSYNC_GPIO_NUM; c.pin_href=HREF_GPIO_NUM;
  c.pin_sccb_sda=SIOD_GPIO_NUM; c.pin_sccb_scl=SIOC_GPIO_NUM; c.pin_pwdn=PWDN_GPIO_NUM; c.pin_reset=RESET_GPIO_NUM;
  c.xclk_freq_hz=20000000; c.pixel_format=PIXFORMAT_JPEG; c.grab_mode=CAMERA_GRAB_LATEST;
  c.fb_count=1;
  if (psramFound()) { c.frame_size=FRAMESIZE_SVGA; c.jpeg_quality=12; c.fb_location=CAMERA_FB_IN_PSRAM; }
  else { c.frame_size=FRAMESIZE_VGA; c.jpeg_quality=14; c.fb_location=CAMERA_FB_IN_DRAM; }
  cameraReady = (esp_camera_init(&c) == ESP_OK);
  return cameraReady;
}

static bool makeSlot(time_t epoch, struct tm &wib, char *slot, size_t n) {
  if (!localtime_r(&epoch, &wib)) return false;
  int mins=wib.tm_hour*60+wib.tm_min;
  if (mins<START_MINUTE || mins>END_MINUTE || (wib.tm_min%INTERVAL_MINUTES)!=0 || wib.tm_sec>8) return false;
  int slotMin=(wib.tm_min/INTERVAL_MINUTES)*INTERVAL_MINUTES;
  snprintf(slot,n,"%04d-%02d-%02d_%02d:%02d",wib.tm_year+1900,wib.tm_mon+1,wib.tm_mday,wib.tm_hour,slotMin);
  return true;
}

static bool uploadFrame(camera_fb_t *fb, const char *slot, time_t epoch, uint16_t hst) {
  if (WiFi.status()!=WL_CONNECTED || !fb || fb->len<100) return false;
  HTTPClient http; http.setTimeout(12000);
  if (!http.begin(RECEIVER_URL)) return false;
  char checksum[9]; snprintf(checksum,sizeof(checksum),"%08lx",(unsigned long)fnv1a(fb->buf,fb->len));
  http.addHeader("Content-Type","image/jpeg");
  http.addHeader("X-Kelompok","Kelompok 5");
  http.addHeader("X-Slot-Key",slot);
  http.addHeader("X-Captured-At",String((unsigned long long)epoch*1000ULL));
  http.addHeader("X-HST-Day",String(hst));
  http.addHeader("X-File-Size",String(fb->len));
  http.addHeader("X-Checksum-FNV1A",checksum);
  int code=http.POST(fb->buf,fb->len);
  String response=code>0 ? http.getString() : "";
  http.end();
  if (code==200 && response.indexOf("\"ok\":true")>=0 && response.indexOf("\"confirmed\":true")>=0) {
    uploadedCount++; return true;
  }
  Serial.printf("[UPLOAD] Failed HTTP=%d; slot will not be marked confirmed.\n",code);
  return false;
}

static bool captureSlot(const char *slot, time_t epoch, uint16_t hst) {
  if (!cameraReady && !initCamera()) { failedCount++; return false; }
  if (WiFi.status()!=WL_CONNECTED) { Serial.println("[CAPTURE] Wi-Fi offline; capture skipped (no local SD queue)."); failedCount++; return false; }
  digitalWrite(LED_STATUS_GPIO,LOW);
  camera_fb_t *fb=esp_camera_fb_get();
  if (!fb) { digitalWrite(LED_STATUS_GPIO,HIGH); failedCount++; return false; }
  bool ok=uploadFrame(fb,slot,epoch,hst);
  esp_camera_fb_return(fb);
  digitalWrite(LED_STATUS_GPIO,HIGH);
  if (ok) {
    capturedCount++;
    strncpy(confirmedSlotKey,slot,sizeof(confirmedSlotKey)-1);
    prefs.putString("confirmed_slot",confirmedSlotKey);
    prefs.putString("last_slot",confirmedSlotKey);
    Serial.printf("[CAPTURE] Confirmed slot %s (HST %u)\n",slot,hst);
    return true;
  }
  failedCount++;
  return false;
}

static esp_err_t streamHandler(httpd_req_t *req) {
  httpd_resp_set_type(req,"multipart/x-mixed-replace;boundary=frame");
  httpd_resp_set_hdr(req,"Access-Control-Allow-Origin","*");
  while (true) {
    camera_fb_t *fb=esp_camera_fb_get(); if(!fb) return ESP_FAIL;
    char part[96]; int len=snprintf(part,sizeof(part),"\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n",(unsigned)fb->len);
    esp_err_t r=httpd_resp_send_chunk(req,part,len);
    if(r==ESP_OK) r=httpd_resp_send_chunk(req,(const char*)fb->buf,fb->len);
    esp_camera_fb_return(fb); if(r!=ESP_OK) return r;
  }
}
static esp_err_t captureHandler(httpd_req_t *req) {
  camera_fb_t *fb=esp_camera_fb_get(); if(!fb) return httpd_resp_send_500(req);
  httpd_resp_set_type(req,"image/jpeg"); httpd_resp_set_hdr(req,"Access-Control-Allow-Origin","*");
  esp_err_t r=httpd_resp_send(req,(const char*)fb->buf,fb->len); esp_camera_fb_return(fb); return r;
}
static esp_err_t statusHandler(httpd_req_t *req) {
  char json[384]; time_t now=time(nullptr); struct tm t={}; localtime_r(&now,&t);
  int hst=(campaignStartEpoch>0 && now>=campaignStartEpoch)?(int)((now-campaignStartEpoch)/86400)+1:1;
  snprintf(json,sizeof(json),"{\"camera_ready\":%s,\"wifi_connected\":%s,\"ntp_synced\":%s,\"captured\":%lu,\"uploaded\":%lu,\"failed\":%lu,\"hst_day\":%d,\"last_slot\":\"%s\",\"confirmed_slot\":\"%s\",\"attempted_slot\":\"%s\",\"stream_endpoint\":\"/stream\"}",cameraReady?"true":"false",WiFi.status()==WL_CONNECTED?"true":"false",ntpSynced?"true":"false",(unsigned long)capturedCount,(unsigned long)uploadedCount,(unsigned long)failedCount,hst,confirmedSlotKey,confirmedSlotKey,attemptedSlotKey);
  httpd_resp_set_type(req,"application/json"); httpd_resp_set_hdr(req,"Access-Control-Allow-Origin","*"); return httpd_resp_send(req,json,strlen(json));
}
static void startServers() {
  httpd_config_t c=HTTPD_DEFAULT_CONFIG(); c.server_port=80;
  httpd_uri_t cap={.uri="/capture",.method=HTTP_GET,.handler=captureHandler,.user_ctx=NULL};
  httpd_uri_t stat={.uri="/status",.method=HTTP_GET,.handler=statusHandler,.user_ctx=NULL};
  if(httpd_start(&controlHttpd,&c)==ESP_OK){httpd_register_uri_handler(controlHttpd,&cap);httpd_register_uri_handler(controlHttpd,&stat);}
  c.server_port=81; c.ctrl_port=32769;
  httpd_uri_t stream={.uri="/stream",.method=HTTP_GET,.handler=streamHandler,.user_ctx=NULL};
  if(httpd_start(&streamHttpd,&c)==ESP_OK) httpd_register_uri_handler(streamHttpd,&stream);
}

void setup() {
  Serial.begin(115200); pinMode(LED_STATUS_GPIO,OUTPUT); digitalWrite(LED_STATUS_GPIO,HIGH);
  prefs.begin("selada-cam",false);
  campaignStartEpoch=(time_t)prefs.getULong64("campaign_start",0);
  String savedConfirmed=prefs.getString("confirmed_slot","");
  if(savedConfirmed.length()==0){savedConfirmed=prefs.getString("last_slot","");}
  savedConfirmed.toCharArray(confirmedSlotKey,sizeof(confirmedSlotKey));
  attemptedSlotKey[0]='\0';
  initCamera();
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID,WIFI_PASS);
  configTime(WIB_GMT_OFFSET_SEC,0,NTP_SERVER);
  startServers();
  Serial.println("[CAM] Wi-Fi autonomous scheduler ready. No microSD. Stream: :81/stream");
}
void loop() {
  unsigned long ms=millis();
  if(WiFi.status()!=WL_CONNECTED && ms-lastWifiRetry>=WIFI_RETRY_MS){lastWifiRetry=ms;WiFi.disconnect();WiFi.begin(WIFI_SSID,WIFI_PASS);}
  if(ms-lastScheduleCheck>=SCHEDULE_CHECK_MS){
    lastScheduleCheck=ms; time_t now=time(nullptr);
    if(now>1700000000L){ntpSynced=true; if(campaignStartEpoch==0){campaignStartEpoch=now;prefs.putULong64("campaign_start",(uint64_t)campaignStartEpoch);}
      struct tm wib={}; char slot[24];
      if(makeSlot(now,wib,slot,sizeof(slot))){
        if(strcmp(slot,confirmedSlotKey)!=0 && strcmp(slot,attemptedSlotKey)!=0){
          int hst=(int)((now-campaignStartEpoch)/86400L)+1;
          if(hst>=1 && hst<=CAMPAIGN_DAYS){
            strncpy(attemptedSlotKey,slot,sizeof(attemptedSlotKey)-1);
            captureSlot(slot,now,(uint16_t)hst);
          }
        }
      }
    }
  }
  yield();
}
