import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import joblib
from datetime import datetime, timedelta, timezone
from pathlib import Path

from forecast_ml import (HORIZON_SECONDS, SENSORS, clean_rows, feature_names,
                         features_for_index, predict, read_database,
                         supervised_examples, train)


def fixture_rows(duration_seconds=10800, step_seconds=30):
    start = datetime.now(timezone.utc) - timedelta(seconds=duration_seconds)
    rows = []
    count = duration_seconds // step_seconds + 1
    for index in range(count):
        seconds = index * step_seconds
        rows.append({
            "timestamp": (start + timedelta(seconds=seconds)).isoformat(),
            "temperature": 25 + (index % 7) * 0.1,
            "humidity": 50 + (index % 5) * 0.2,
            "light": 2200 + index % 30,
            "air_quality": 800 + index % 20,
        })
    return rows


class ForecastFeatureTests(unittest.TestCase):
    def test_missing_invalid_rows_are_excluded_but_zero_is_not_assumed_missing(self):
        now = datetime.now(timezone.utc)
        valid_zero = {"timestamp": now.isoformat(), "temperature": 0, "humidity": 0, "light": 0, "air_quality": 0}
        missing = {**valid_zero, "timestamp": (now + timedelta(seconds=1)).isoformat(), "light": None}
        invalid = {**valid_zero, "timestamp": (now + timedelta(seconds=2)).isoformat(), "air_quality": 5000}
        cleaned = clean_rows([valid_zero, missing, invalid])
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["light"], 0)

    def test_lag_features_use_only_past_readings_and_have_stable_shape(self):
        rows = clean_rows(fixture_rows())
        index = len(rows) - 1
        features = features_for_index(rows, index)
        self.assertIsNotNone(features)
        self.assertEqual(len(features), len(feature_names()))
        self.assertEqual(features[0], rows[index]["temperature"])
        self.assertLessEqual(rows[index - 1]["_seconds"], rows[index]["_seconds"])
        altered = [dict(row) for row in rows]
        for row in altered[index + 1:]:
            for sensor in SENSORS:
                row[sensor] += 10
        self.assertEqual(features, features_for_index(altered, index))

    def test_irregular_gap_is_not_treated_as_a_regular_input_window(self):
        rows = fixture_rows()
        rows = [row for row in rows if not (6000 <= (datetime.fromisoformat(row["timestamp"]) - datetime.fromisoformat(rows[0]["timestamp"])).total_seconds() <= 6300)]
        cleaned = clean_rows(rows)
        features = features_for_index(cleaned, len(cleaned) - 1)
        self.assertIsNotNone(features)
        gap_index = next(i for i in range(1, len(cleaned)) if cleaned[i]["_seconds"] - cleaned[i - 1]["_seconds"] > 60)
        self.assertIsNone(features_for_index(cleaned, gap_index))

    def test_targets_align_to_real_future_readings_with_tolerance(self):
        rows = clean_rows(fixture_rows())
        examples = supervised_examples(rows)
        self.assertGreater(len(examples), 30)
        self.assertTrue(all(examples[i]["base_at"] - examples[i - 1]["base_at"] >= 300 for i in range(1, len(examples))))
        for example in examples:
            self.assertGreaterEqual(example["target_at"] - example["base_at"], HORIZON_SECONDS)
            self.assertLessEqual(example["target_at"] - example["base_at"], HORIZON_SECONDS + 30)

    def test_training_serializes_models_and_chronological_metrics(self):
        rows = fixture_rows()
        with tempfile.TemporaryDirectory() as temp:
            db_path = Path(temp) / "readings.db"
            output_dir = Path(temp) / "models"
            connection = sqlite3.connect(db_path)
            try:
                connection.execute("CREATE TABLE readings (id INTEGER PRIMARY KEY, temperature REAL, humidity REAL, light REAL, air_quality REAL, recorded_at TEXT)")
                connection.executemany("INSERT INTO readings (temperature, humidity, light, air_quality, recorded_at) VALUES (?, ?, ?, ?, ?)",
                    [(row["temperature"], row["humidity"], row["light"], row["air_quality"], row["timestamp"]) for row in rows])
                connection.commit()
            finally:
                connection.close()
            result = train(db_path, output_dir)
            self.assertEqual(result["valid_readings"], len(rows))
            self.assertTrue((output_dir / "forecast.joblib").exists())
            self.assertTrue((output_dir / "evaluation.json").exists())
            self.assertTrue(joblib.load(output_dir / "forecast.joblib")["estimators"])
            self.assertEqual(set(result["targets"]), set(SENSORS))
            for metrics in result["targets"].values():
                if metrics["status"] == "evaluated":
                    self.assertIn("mae", metrics["persistence"])
                    self.assertGreater(metrics["test_examples"], 0)
                    self.assertLess(metrics["training_target_period"][1], metrics["evaluation_period"][0])
            result_forecast = predict(rows, output_dir)
            self.assertIn(result_forecast["status"], ("model", "baseline_fallback"))
            self.assertEqual(set(result_forecast["values"]), set(SENSORS))

    def test_worker_json_line_input_and_output(self):
        process = subprocess.run([sys.executable, "forecast_service.py"], input='{"readings": []}\n',
            text=True, capture_output=True, cwd=Path(__file__).resolve().parents[1], timeout=20)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout.splitlines()[-1])["status"], "unavailable")

    def test_stale_input_never_returns_a_fresh_forecast(self):
        rows = fixture_rows()
        for row in rows:
            row["timestamp"] = (datetime.fromisoformat(row["timestamp"]) - timedelta(minutes=2)).isoformat()
        result = predict(rows, Path("missing-model-directory"))
        self.assertEqual(result["status"], "stale")


if __name__ == "__main__":
    unittest.main()
