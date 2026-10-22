"""
Smart Study Environment Sensing System (SSES)
Machine Learning Prediction Microservice (FastAPI + Scikit-Learn)

Predicts future environment parameters (15m, 30m, 60m horizon)
and computes study comfort degradation warnings.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Sequence
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

app = FastAPI(title="SSES ML Prediction Engine", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ReadingTick(BaseModel):
    temperature: float
    humidity: float
    light: float
    airQuality: float
    recorded_at: Optional[str] = None

class PredictionRequest(BaseModel):
    current: ReadingTick
    history: List[ReadingTick]

def _parse_timestamp(value: Optional[str]) -> Optional[pd.Timestamp]:
    if not value:
        return None
    parsed = pd.to_datetime(value, utc=True, errors="coerce")
    return None if pd.isna(parsed) else parsed


def forecast_series(
    series: Sequence[float],
    horizons_minutes: Sequence[int],
    timestamps: Optional[Sequence[Optional[str]]] = None,
    bounds: tuple[float, float] = (0.0, 4095.0),
) -> List[float]:
    """Fit a robust linear Ridge trend and damp it for long-range forecasts.

    Sensor readings arrive about every two seconds. Timestamps are used when
    available; otherwise that cadence is assumed. The fit uses the latest 60
    readings, smooths isolated spikes with a short rolling median, and limits
    the trend's long-range effect because a two-minute history cannot support
    unconstrained 15–60 minute extrapolation.
    """
    values = np.asarray(series, dtype=float)
    valid = np.isfinite(values)
    values = values[valid]
    if values.size == 0:
        return [0.0 for _ in horizons_minutes]

    parsed_times: list[Optional[pd.Timestamp]] = []
    if timestamps is not None and len(timestamps) == len(valid):
        parsed_times = [_parse_timestamp(t) for t, keep in zip(timestamps, valid) if keep]

    if len(parsed_times) == values.size and all(t is not None for t in parsed_times):
        time_minutes = np.array([(t - parsed_times[-1]).total_seconds() / 60.0 for t in parsed_times])
        if np.any(np.diff(time_minutes) <= 0):
            time_minutes = np.arange(values.size, dtype=float) * (2.0 / 60.0)
            time_minutes -= time_minutes[-1]
    else:
        time_minutes = np.arange(values.size, dtype=float) * (2.0 / 60.0)
        time_minutes -= time_minutes[-1]

    values = values[-60:]
    time_minutes = time_minutes[-60:]

    # A rolling median reduces single-sample ADC/DHT spikes without erasing trend.
    smooth = np.array([
        np.median(values[max(0, i - 2):i + 1]) for i in range(values.size)
    ])
    baseline = float(np.median(smooth[-5:]))
    slope_per_minute = 0.0

    if values.size >= 5 and np.ptp(time_minutes) > 0:
        x = (time_minutes - time_minutes[-1]).reshape(-1, 1)
        model = Ridge(alpha=0.01)
        model.fit(x, smooth)
        slope_per_minute = float(model.coef_[0])

    # The damped trend approaches a finite adjustment instead of growing
    # without limit when forecasting far beyond the observed history.
    damping_minutes = 5.0
    lower, upper = bounds
    forecasts = []
    for horizon in horizons_minutes:
        effective_minutes = damping_minutes * (1.0 - np.exp(-max(0, horizon) / damping_minutes))
        prediction = baseline + slope_per_minute * effective_minutes
        forecasts.append(round(float(np.clip(prediction, lower, upper)), 1))
    return forecasts

def evaluate_status(temp: float, hum: float, air_q: float) -> str:
    if 20 <= temp <= 28 and 40 <= hum <= 65 and air_q < 350:
        return "Ideal"
    elif (28 < temp <= 32) or (65 < hum <= 75) or (350 <= air_q < 500):
        return "Moderate"
    else:
        return "Poor"

def generate_recommendation(curr: ReadingTick, pred_15: dict, pred_30: dict, pred_60: dict) -> str:
    issues = []

    # ── Temperature checks ────────────────────────────────────────────
    temp_now = curr.temperature
    temp_15  = pred_15["temperature"]
    temp_30  = pred_30["temperature"]

    if temp_15 > 30.0 or temp_30 > 30.0:
        issues.append((3, "🌡️ Room temperature will exceed 30°C soon — heat stress impairs memory retention by up to 30%. Turn on the fan or AC now to stay sharp."))
    elif temp_now > 28.0:
        issues.append((2, "🌡️ It's getting warm in your study space. Optimal learning happens between 20–25°C. Consider cooling the room for better concentration."))
    elif temp_now < 18.0:
        issues.append((2, "🥶 Room is too cold for effective studying. Low temperatures can slow cognitive processing. Warm it up to 20–23°C for peak focus."))

    # ── Humidity checks ───────────────────────────────────────────────
    hum_now = curr.humidity
    hum_15  = pred_15["humidity"]

    if hum_15 > 70.0:
        issues.append((3, "💧 Humidity will rise above 70% soon — high moisture causes drowsiness and reduces alertness. Run a dehumidifier or open a window."))
    elif hum_now > 65.0:
        issues.append((2, "💧 Humidity is above the ideal study range (40–60%). This can cause fatigue. Ventilate the room for better focus."))
    elif hum_now < 30.0:
        issues.append((1, "🏜️ Air is too dry for your study space. Low humidity causes throat dryness and headaches. Keep a water bottle close and consider a humidifier."))

    # ── Air Quality checks ────────────────────────────────────────────
    aq_now = curr.airQuality
    aq_15  = pred_15["airQuality"]
    aq_30  = pred_30["airQuality"]

    if aq_15 >= 400 or aq_30 >= 400:
        issues.append((3, "🌫️ The MQ-135 reading is projected to be high. Ventilate the room and check the sensor."))
    elif aq_now >= 350:
        issues.append((2, "🌫️ The MQ-135 reading is high. Ventilate the room and keep monitoring the sensor."))
    elif aq_15 >= 300:
        issues.append((1, "💨 The MQ-135 reading is trending upward. Ventilate the room and keep monitoring it."))

    # ── Light checks ──────────────────────────────────────────────────
    light_now = curr.light

    if light_now >= 3500:
        issues.append((2, "💡 Light levels are very low — studying in dim light causes eye strain and headaches within 30 minutes. Turn on your study lamp now."))
    elif light_now >= 2500:
        issues.append((1, "💡 Ambient light is slightly low. Adequate lighting helps sustain focus for longer study sessions. Consider brightening your workspace."))

    # ── Return highest-priority issue or all-clear ────────────────────
    if issues:
        issues.sort(key=lambda x: -x[0])  # Sort by priority descending
        return issues[0][1]

    # All-clear messages based on current conditions
    if temp_now <= 24.0 and hum_now <= 55.0 and aq_now < 300:
        return "✅ Current readings are within the configured study ranges. Keep monitoring as conditions change."
    else:
        return "✅ Recent readings are stable and within acceptable study ranges. Keep monitoring your environment as conditions change."

@app.get("/")
def read_root():
    return {"status": "online", "service": "SSES ML Prediction Microservice"}

@app.post("/predict")
def predict_environment(req: PredictionRequest):
    try:
        # Use the supplied recent readings, falling back to the current tick
        # when there is no history yet. Keep timestamps aligned with each series.
        readings = req.history or [req.current]
        timestamps = [reading.recorded_at for reading in readings]

        def forecast(attribute: str, bounds: tuple[float, float]) -> List[float]:
            values = [getattr(reading, attribute) for reading in readings]
            return forecast_series(values, [15, 30, 60], timestamps, bounds)

        pred_temps = forecast("temperature", (-40.0, 80.0))
        pred_hums = forecast("humidity", (0.0, 100.0))
        pred_lights = forecast("light", (0.0, 4095.0))
        pred_aqs = forecast("airQuality", (0.0, 4095.0))
        
        p15 = {
            "temperature": pred_temps[0],
            "humidity": pred_hums[0],
            "light": pred_lights[0],
            "airQuality": pred_aqs[0],
            "status": evaluate_status(pred_temps[0], pred_hums[0], pred_aqs[0]),
            "timeHorizon": "15 mins"
        }
        
        p30 = {
            "temperature": pred_temps[1],
            "humidity": pred_hums[1],
            "light": pred_lights[1],
            "airQuality": pred_aqs[1],
            "status": evaluate_status(pred_temps[1], pred_hums[1], pred_aqs[1]),
            "timeHorizon": "30 mins"
        }
        
        p60 = {
            "temperature": pred_temps[2],
            "humidity": pred_hums[2],
            "light": pred_lights[2],
            "airQuality": pred_aqs[2],
            "status": evaluate_status(pred_temps[2], pred_hums[2], pred_aqs[2]),
            "timeHorizon": "60 mins"
        }
        
        recommendation = generate_recommendation(req.current, p15, p30, p60)
        return {
            "success": True,
            "forecast_15m": p15,
            "forecast_30m": p30,
            "forecast_60m": p60,
            "recommendation": recommendation,
            "modelAlgorithm": "Damped Ridge trend (recent sensor history)"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
