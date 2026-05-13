# 📡 SSES Dashboard — Smart Study Environment Sensing System

A real-time IoT dashboard for monitoring your study environment using an **ESP32**, **DHT22**, **MQ135**, and **LDR** sensor.

---

## 🗂️ Project Structure

```
iot project 1/
├── backend/           Node.js + Express + Socket.io server
│   └── server.js
├── frontend/          React (Vite) dashboard
│   └── src/App.jsx
├── SSES_ESP32.ino     Updated Arduino firmware (WiFi-enabled)
└── README.md
```

---

## ⚡ Quick Start

### 1. Find Your PC's Local IP

Open PowerShell / Command Prompt and run:
```
ipconfig
```
Note the **IPv4 Address** under your WiFi adapter (e.g., `192.168.1.42`).

---

### 2. Configure the Arduino Sketch

Open `SSES_ESP32.ino` in Arduino IDE and update:
```cpp
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
const char* SERVER_IP = "192.168.1.XX";  // ← Your PC's IP
```

Also install these libraries from Arduino Library Manager:
- **DHT sensor library** by Adafruit
- **ArduinoJson** by Benoit Blanchon
- **HTTPClient** (included in ESP32 board package)

Upload to your ESP32, open Serial Monitor (115200 baud) and verify WiFi connects.

---

### 3. Start the Backend

```bash
cd backend
node server.js
```

The server will print the correct endpoint URL for your ESP32.

---

### 4. Start the Frontend

```bash
cd frontend
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 📊 API Reference

| Method | Endpoint             | Description                  |
|--------|----------------------|------------------------------|
| POST   | `/api/sensor-data`   | ESP32 sends sensor readings  |
| GET    | `/api/sensor-data`   | Fetch latest snapshot        |
| GET    | `/api/health`        | Server health check          |

### POST Payload (from ESP32)
```json
{
  "temperature": 24.5,
  "humidity": 55.2,
  "light": 1820,
  "airQuality": 280,
  "status": "Ideal"
}
```

---

## 🔌 Hardware Pins

| Sensor   | Pin   |
|----------|-------|
| DHT22    | GPIO 4 |
| LDR      | ADC 35 |
| MQ135    | ADC 34 |
| Green LED| GPIO 18|
| Yellow LED| GPIO 19|
| Red LED  | GPIO 21|
