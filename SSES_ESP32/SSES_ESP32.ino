/*
  Smart Study Environment Sensing System (SSES)
  ESP32 Firmware — WiFi Edition

  Sends sensor data to Node.js backend via HTTP POST every 2 seconds.
  Update WIFI_SSID, WIFI_PASS, and SERVER_IP before uploading.
*/

#include "DHT.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ─── WiFi Config ─────────────────────────────────────────
const char* WIFI_SSID = "Excitel_2.4G No Internet";      // ← Replace with your WiFi name
const char* WIFI_PASS = "danzocmtrs";  // ← Replace with your WiFi password

// ─── Backend Config ───────────────────────────────────────
// Run `ipconfig` on your PC and use the IPv4 address shown under Wi-Fi
const char* SERVER_IP   = "192.168.1.33";  // ← e.g. 192.168.1.33
const int   SERVER_PORT = 3001;
const char* ENDPOINT    = "/api/sensor-data";

// ─── Pin Definitions ──────────────────────────────────────
#define DHTPIN    4
#define DHTTYPE   DHT22
#define LDR_PIN   35
#define MQ135_PIN 34
#define GREEN_LED 18
#define YELLOW_LED 19
#define RED_LED   21

DHT dht(DHTPIN, DHTTYPE);

// ─── Helper: connect to Wi‑Fi with timeout ─────────────────
bool connectWiFi(uint32_t timeoutMs = 15000) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();
  return WiFi.status() == WL_CONNECTED;
}

// ─── Setup ────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  dht.begin();

  pinMode(GREEN_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);

  // Try to connect; if it fails we’ll retry in loop
  if (!connectWiFi()) {
    Serial.println("⚠️ WiFi not connected – will retry in loop");
  }
}

// ─── Send Data to Backend ─────────────────────────────────
bool sendDataWithRetry(float temp, float hum, int light, int airQuality, const char* status, int maxAttempts = 3) {
  if (WiFi.status() != WL_CONNECTED) {
    if (!connectWiFi(5000)) { // quick reconnect attempt
      return false;
    }
  }

  HTTPClient http;
  String url = "http://" + String(SERVER_IP) + ":" + SERVER_PORT + ENDPOINT;
  bool success = false;

  for (int attempt = 0; attempt < maxAttempts && !success; ++attempt) {
    http.begin(url);
    http.addHeader("Content-Type", "application/json");

    // Build JSON payload
    StaticJsonDocument<256> doc;
    doc["temperature"] = temp;
    doc["humidity"]    = hum;
    doc["light"]       = light;
    doc["airQuality"]  = airQuality;
    doc["status"]      = status;

    String payload;
    serializeJson(doc, payload);

    int code = http.POST(payload);
    if (code >= 200 && code < 300) {
      Serial.printf("   [HTTP] ✅ Sent — Response: %d\n", code);
      success = true;
    } else {
      Serial.printf("   [HTTP] ❌ Failed — Code: %d (attempt %d/%d)\n", code, attempt + 1, maxAttempts);
    }
    http.end();
    if (!success && attempt < maxAttempts - 1) {
      delay(1000); // wait before retry
    }
  }
  return success;
}

// ─── Main Loop ────────────────────────────────────────────
void loop() {
  // (Re‑connect if we lost Wi‑Fi)
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\n📶 Wi‑Fi lost, reconnecting...");
    if (!connectWiFi()) {
      Serial.println("❌ Re‑try failed – waiting 5s before next attempt");
      delay(5000);
      return;   // skip this cycle, try again later
    }
    Serial.println("✅ Wi‑Fi reconnected!");
  }

  float temp = dht.readTemperature();
  float hum  = dht.readHumidity();
  int lightValue = analogRead(LDR_PIN);
  int airValue   = analogRead(MQ135_PIN);

  // Validate DHT reading
  if (isnan(temp) || isnan(hum)) {
    Serial.println("❌ DHT read failed — skipping cycle");
    delay(2000);
    return;
  }

  Serial.printf("Temp: %.1f°C  Hum: %.1f%%  Light: %d  AQ: %d\n",
                temp, hum, lightValue, airValue);

  const char* status;

  // IDEAL CONDITIONS
  if (temp >= 20 && temp <= 28 &&
      hum  >= 40 && hum  <= 65 &&
      lightValue < 3500 &&
      airValue   < 350) {

    digitalWrite(GREEN_LED,  HIGH);
    digitalWrite(YELLOW_LED, LOW);
    digitalWrite(RED_LED,    LOW);
    status = "Ideal";
    Serial.println("✅ Ideal study environment");

  // MODERATE CONDITIONS
  } else if ((temp > 28 && temp <= 32) ||
             (hum  > 65 && hum  <= 75) ||
             (airValue >= 350 && airValue < 500)) {

    digitalWrite(GREEN_LED,  LOW);
    digitalWrite(YELLOW_LED, HIGH);
    digitalWrite(RED_LED,    LOW);
    status = "Moderate";
    Serial.println("⚠ Moderate environment");

  // POOR CONDITIONS
  } else {
    digitalWrite(GREEN_LED,  LOW);
    digitalWrite(YELLOW_LED, LOW);
    digitalWrite(RED_LED,    HIGH);
    status = "Poor";
    Serial.println("❌ Poor study environment");
  }

  // Send data to dashboard backend with retries
  sendDataWithRetry(temp, hum, lightValue, airValue, status);

  Serial.println("---------------------------");
  delay(2000);   // keep your 2‑second interval
}