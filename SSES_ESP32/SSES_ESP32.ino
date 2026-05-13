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
const char* WIFI_SSID = "YOUR_WIFI_SSID";      // ← Replace with your WiFi name
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";  // ← Replace with your WiFi password

// ─── Backend Config ───────────────────────────────────────
// Run `ipconfig` on your PC and use the IPv4 address shown under Wi-Fi
const char* SERVER_IP   = "YOUR_PC_LOCAL_IP";  // ← e.g. 192.168.1.40
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

// ─── Setup ────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  dht.begin();

  pinMode(GREEN_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);

  // Connect to WiFi
  Serial.printf("\nConnecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi connected!");
    Serial.print("   IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n❌ WiFi failed — running in serial-only mode");
  }
}

// ─── Send Data to Backend ─────────────────────────────────
void sendData(float temp, float hum, int light, int airQuality, const char* status) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = "http://" + String(SERVER_IP) + ":" + SERVER_PORT + ENDPOINT;
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
  if (code == 200) {
    Serial.printf("   [HTTP] ✅ Sent — Response: %d\n", code);
  } else {
    Serial.printf("   [HTTP] ❌ Failed — Code: %d\n", code);
  }
  http.end();
}

// ─── Main Loop ────────────────────────────────────────────
void loop() {
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

  // Send data to dashboard backend
  sendData(temp, hum, lightValue, airValue, status);

  Serial.println("---------------------------");
  delay(2000);
}
