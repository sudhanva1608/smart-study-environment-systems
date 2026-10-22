# SSES five-minute forecasting

The forecast worker reads only validated rows from the existing local `sses.db`. It builds latest-value, lag, rolling mean/standard-deviation, trend, sample-gap and UTC time-of-day features using readings at or before each forecast time. The target is the first real reading from 5:00 to 5:30 minutes later. Training examples are spaced at least five minutes apart. The newest 20% is held out chronologically, and training targets that reach the first test timestamp are purged.

Random Forest and HistGradientBoosting are compared with persistence for each sensor. The operational choice is the lowest-MAE candidate only if it beats persistence MAE on that same held-out period; otherwise the dashboard uses the latest actual reading as a labeled fallback. Evaluation metrics and the local model bundle are written under `backend/models/` and are git-ignored. Training is manual; it does not run on every MQTT reading.

## Windows commands

From `backend`:

```powershell
py -3 -m pip install -r requirements-forecast.txt
py -3 train_forecast.py
npm test
npm start
```

In a second terminal, from `frontend`:

```powershell
npm run dev
```

Open the Vite URL printed by the frontend. The dashboard requests a forecast once per minute. To evaluate newer stored history, rerun `py -3 train_forecast.py`; the worker reloads the saved artifacts on its next forecast request. If `py` is unavailable, set `SSES_PYTHON` to the Python executable before starting the backend.

## Live demonstration

1. Keep the ESP32 publishing through the existing MQTT topic and leave the dashboard open for at least five minutes.
2. Run the training command and review each sensor's holdout MAE/RMSE, persistence MAE, test count and evaluation dates in its output.
3. Open **Recommendations & Alerts**. Read the forecast generation time, five-minute target time, per-sensor forecast method and raw ADC units.
4. Wait until the forecast target has passed. A new sensor reading within 30 seconds after the target is matched and the absolute error appears in the panel.
5. If a model did not beat persistence, show the labeled fallback and its measured holdout comparison; do not describe it as an accurate ML forecast.
