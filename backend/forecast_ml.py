"""Small chronological training and inference pipeline for real SSES readings."""
from __future__ import annotations

import bisect
import json
import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error
import joblib

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "sses.db"
MODEL_DIR = ROOT / "models"
MODEL_PATH = MODEL_DIR / "forecast.joblib"
METRICS_PATH = MODEL_DIR / "evaluation.json"
SENSORS = ("temperature", "humidity", "light", "airQuality")
BOUNDS = {"temperature": (-40.0, 80.0), "humidity": (0.0, 100.0),
          "light": (0.0, 4095.0), "airQuality": (0.0, 4095.0)}
HORIZON_SECONDS = 300
TARGET_TOLERANCE_SECONDS = 30
SAMPLE_STRIDE_SECONDS = 300
MAX_HISTORY_ROWS = 20000


def parse_time(value: Any) -> float | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, OverflowError):
        return None


def clean_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cleaned = []
    for row in rows:
        timestamp = row.get("timestamp", row.get("recorded_at"))
        seconds = parse_time(timestamp)
        if seconds is None:
            continue
        item: dict[str, Any] = {"timestamp": timestamp, "_seconds": seconds}
        valid = True
        for sensor in SENSORS:
            raw = row.get(sensor, row.get("air_quality") if sensor == "airQuality" else None)
            try:
                value = float(raw)
            except (TypeError, ValueError):
                valid = False
                break
            low, high = BOUNDS[sensor]
            if not math.isfinite(value) or value < low or value > high:
                valid = False
                break
            item[sensor] = value
        if valid:
            cleaned.append(item)
    cleaned.sort(key=lambda row: row["_seconds"])
    # Repeated deliveries with an identical timestamp are one historical sample.
    deduplicated = {}
    for row in cleaned:
        deduplicated[row["_seconds"]] = row
    return list(deduplicated.values())


def feature_names() -> list[str]:
    names = []
    for sensor in SENSORS:
        names.append(f"{sensor}_latest")
        for lag in (30, 120, 300):
            names.extend((f"{sensor}_lag_{lag}s", f"{sensor}_lag_age_{lag}s"))
        names.append(f"{sensor}_trend_5m_per_min")
        for window in (60, 300):
            names.extend((f"{sensor}_mean_{window}s", f"{sensor}_std_{window}s"))
    return names + ["last_gap_seconds", "time_of_day_sin", "time_of_day_cos"]


def features_for_index(rows: list[dict[str, Any]], index: int) -> list[float] | None:
    if index < 2:
        return None
    times = [row["_seconds"] for row in rows]
    now = times[index]
    if now - times[index - 1] > 60:
        return None
    earliest = bisect.bisect_left(times, now - 300, 0, index + 1)
    window_rows = rows[earliest:index + 1]
    if len(window_rows) < 3 or now - window_rows[0]["_seconds"] < 240:
        return None
    if any(times[offset] - times[offset - 1] > 60 for offset in range(earliest + 1, index + 1)):
        return None

    features: list[float] = []
    for sensor in SENSORS:
        current = rows[index][sensor]
        features.append(current)
        lag_indexes = []
        for lag in (30, 120, 300):
            lag_index = bisect.bisect_right(times, now - lag, 0, index + 1) - 1
            if lag_index < 0:
                return None
            lag_indexes.append(lag_index)
            features.extend((rows[lag_index][sensor], now - times[lag_index]))
        lag5 = rows[lag_indexes[-1]][sensor]
        actual_minutes = max((now - times[lag_indexes[-1]]) / 60.0, 1e-6)
        features.append((current - lag5) / actual_minutes)
        for seconds in (60, 300):
            start = bisect.bisect_left(times, now - seconds, 0, index + 1)
            values = np.asarray([row[sensor] for row in rows[start:index + 1]], dtype=float)
            features.extend((float(values.mean()), float(values.std(ddof=0))))

    features.append(now - times[index - 1])
    day_seconds = datetime.fromtimestamp(now, timezone.utc).hour * 3600 + datetime.fromtimestamp(now, timezone.utc).minute * 60 + datetime.fromtimestamp(now, timezone.utc).second
    phase = 2 * math.pi * day_seconds / 86400
    features.extend((math.sin(phase), math.cos(phase)))
    return features


def supervised_examples(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    times = [row["_seconds"] for row in rows]
    examples = []
    last_base = -math.inf
    for index, now in enumerate(times):
        if now - last_base < SAMPLE_STRIDE_SECONDS:
            continue
        target_index = bisect.bisect_left(times, now + HORIZON_SECONDS)
        if target_index >= len(rows) or abs(times[target_index] - (now + HORIZON_SECONDS)) > TARGET_TOLERANCE_SECONDS:
            continue
        features = features_for_index(rows, index)
        if features is None:
            continue
        if target_index == 0 or times[target_index] - times[target_index - 1] > 60:
            continue
        examples.append({"base_at": now, "target_at": times[target_index],
                         "features": features, "target": rows[target_index]})
        last_base = now
    return examples


def read_database(db_path: Path = DB_PATH) -> list[dict[str, Any]]:
    connection = sqlite3.connect(db_path)
    try:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            "SELECT temperature, humidity, light, air_quality, recorded_at "
            "FROM readings ORDER BY recorded_at, id LIMIT ?", (MAX_HISTORY_ROWS,)
        ).fetchall()
    finally:
        connection.close()
    return clean_rows([dict(row) for row in rows])


def _metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float]:
    return {"mae": round(float(mean_absolute_error(actual, predicted)), 4),
            "rmse": round(float(math.sqrt(mean_squared_error(actual, predicted))), 4)}


def train(db_path: Path = DB_PATH, output_dir: Path = MODEL_DIR) -> dict[str, Any]:
    rows = read_database(db_path)
    examples = supervised_examples(rows)
    evaluation: dict[str, Any] = {
        "status": "insufficient_data", "algorithm": "RandomForestRegressor vs HistGradientBoostingRegressor vs persistence",
        "horizon_seconds": HORIZON_SECONDS, "target_tolerance_seconds": TARGET_TOLERANCE_SECONDS,
        "sampling_stride_seconds": SAMPLE_STRIDE_SECONDS, "feature_names": feature_names(),
        "valid_readings": len(rows), "usable_examples": len(examples), "targets": {},
        "note": "Trained only from actual SQLite readings; no synthetic samples."
    }
    estimators: dict[str, Any] = {}
    target_rows: dict[str, list[dict[str, Any]]] = {}
    any_trained = False

    for sensor in SENSORS:
        usable = [example for example in examples if sensor in example["target"]]
        result: dict[str, Any] = {"usable_examples": len(usable), "status": "insufficient_data"}
        evaluation["targets"][sensor] = result
        if len(usable) < 30:
            result["reason"] = "Need at least 30 aligned, non-overlapping 5-minute examples."
            continue

        split = max(1, int(len(usable) * 0.8))
        first_test_base = usable[split]["base_at"] if split < len(usable) else math.inf
        train_rows = [example for example in usable[:split] if example["target_at"] < first_test_base]
        test_rows = usable[split:]
        if len(train_rows) < 20 or len(test_rows) < 6:
            result["reason"] = "Chronological holdout is too small after the 5-minute leakage gap."
            continue

        x_train = np.asarray([item["features"] for item in train_rows], dtype=float)
        y_train = np.asarray([item["target"][sensor] for item in train_rows], dtype=float)
        x_test = np.asarray([item["features"] for item in test_rows], dtype=float)
        y_test = np.asarray([item["target"][sensor] for item in test_rows], dtype=float)
        persistence = np.asarray([item["features"][SENSORS.index(sensor) * 12] for item in test_rows], dtype=float)
        # Feature layout begins with the latest reading for each sensor.
        baseline_metrics = _metrics(y_test, persistence)
        result.update({"status": "evaluated", "training_examples": len(train_rows),
                       "test_examples": len(test_rows),
                       "training_period": [train_rows[0]["base_at"], train_rows[-1]["base_at"]],
                       "training_target_period": [train_rows[0]["target_at"], train_rows[-1]["target_at"]],
                       "evaluation_period": [test_rows[0]["base_at"], test_rows[-1]["base_at"]],
                       "persistence": baseline_metrics})

        candidates = {
            "random_forest": RandomForestRegressor(n_estimators=100, max_depth=8,
                min_samples_leaf=2, random_state=42, n_jobs=1),
            "hist_gradient_boosting": HistGradientBoostingRegressor(max_iter=100,
                max_leaf_nodes=15, l2_regularization=1.0, random_state=42)
        }
        scored = []
        for name, estimator in candidates.items():
            estimator.fit(x_train, y_train)
            prediction = np.clip(estimator.predict(x_test), *BOUNDS[sensor])
            scored.append((mean_absolute_error(y_test, prediction), name, estimator,
                           prediction, _metrics(y_test, prediction)))
        scored.sort(key=lambda item: item[0])
        _, winner, estimator, _, winner_metrics = scored[0]
        # Keep the evaluated best ML candidate for reproducibility even when
        # persistence remains the safer operational choice.
        estimators[sensor] = estimator
        result["candidates"] = {name: metrics for _, name, _, _, metrics in scored}
        result["selected_candidate"] = winner
        result["selected_metrics"] = winner_metrics
        if winner_metrics["mae"] < baseline_metrics["mae"]:
            result["operational_model"] = winner
            any_trained = True
        else:
            result["operational_model"] = "persistence"
            result["reason"] = "ML did not beat persistence MAE on the chronological holdout; fallback retained."
        target_rows[sensor] = usable

    evaluation["status"] = "trained" if any_trained else (
        "evaluated_baseline_fallback" if any(t.get("status") == "evaluated" for t in evaluation["targets"].values()) else "insufficient_data"
    )
    evaluation["trained_at"] = datetime.now(timezone.utc).isoformat()
    evaluation["training_cutoff"] = max(
        (target["training_target_period"][1] for target in evaluation["targets"].values() if "training_target_period" in target),
        default=None,
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    METRICS = output_dir / METRICS_PATH.name
    MODEL = output_dir / MODEL_PATH.name
    METRICS.write_text(json.dumps(evaluation, indent=2), encoding="utf-8")
    joblib.dump({"estimators": estimators, "feature_names": feature_names(),
                 "training_cutoff": evaluation["training_cutoff"],
                 "horizon_seconds": HORIZON_SECONDS}, MODEL)
    return evaluation


def predict(rows: list[dict[str, Any]], model_dir: Path = MODEL_DIR) -> dict[str, Any]:
    cleaned = clean_rows(rows)
    now = datetime.now(timezone.utc).timestamp()
    if not cleaned:
        return {"status": "unavailable", "reason": "No valid historical readings."}
    latest = cleaned[-1]
    if now - latest["_seconds"] < -30:
        return {"status": "unavailable", "reason": "Latest sensor timestamp is unexpectedly in the future.",
                "source_reading_at": latest["timestamp"]}
    if now - latest["_seconds"] > 60:
        return {"status": "stale", "reason": "Latest sensor reading is older than 60 seconds.",
                "source_reading_at": latest["timestamp"]}
    features = features_for_index(cleaned, len(cleaned) - 1)
    if features is None:
        return {"status": "unavailable", "reason": "At least five minutes of recent, continuous readings are required.",
                "source_reading_at": latest["timestamp"]}

    metrics_path = model_dir / METRICS_PATH.name
    model_path = model_dir / MODEL_PATH.name
    evaluation = {}
    bundle = {}
    try:
        if metrics_path.exists():
            evaluation = json.loads(metrics_path.read_text(encoding="utf-8"))
        if model_path.exists():
            bundle = joblib.load(model_path)
    except Exception as error:
        return {"status": "baseline_fallback", "reason": f"Saved model could not be loaded: {type(error).__name__}.",
                "source_reading_at": latest["timestamp"], "values": {sensor: latest[sensor] for sensor in SENSORS}}

    values, methods = {}, {}
    for sensor in SENSORS:
        target_evaluation = evaluation.get("targets", {}).get(sensor, {})
        estimator = bundle.get("estimators", {}).get(sensor)
        if target_evaluation.get("operational_model") not in ("random_forest", "hist_gradient_boosting") or estimator is None:
            values[sensor] = latest[sensor]
            methods[sensor] = "persistence"
            continue
        low, high = BOUNDS[sensor]
        values[sensor] = float(np.clip(estimator.predict(np.asarray([features]))[0], low, high))
        methods[sensor] = target_evaluation["operational_model"]
    status = "model" if any(value != "persistence" for value in methods.values()) else "baseline_fallback"
    fallback_sensors = [sensor for sensor, item in evaluation.get("targets", {}).items()
                        if item.get("operational_model") == "persistence"]
    fallback_reasons = list(dict.fromkeys(item.get("reason") for item in evaluation.get("targets", {}).values() if item.get("reason")))
    reason = None
    if status == "baseline_fallback":
        reason = ("ML did not beat persistence in the chronological holdout for " + ", ".join(fallback_sensors) + "; latest readings are used as the operational fallback.") if fallback_sensors else (fallback_reasons[0] if fallback_reasons else "No evaluated ML model is available; persistence is used until a manual training run can evaluate more data.")
    return {"status": status, "source_reading_at": latest["timestamp"],
            "target_at": datetime.fromtimestamp(latest["_seconds"] + HORIZON_SECONDS, timezone.utc).isoformat(),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "horizon_seconds": HORIZON_SECONDS, "values": values, "methods": methods,
            "reason": reason,
            "evaluation": evaluation}

