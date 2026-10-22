"""Train and chronologically evaluate forecasts from genuine local SQLite data."""
import json
from forecast_ml import train

if __name__ == "__main__":
    result = train()
    print(json.dumps(result, indent=2))
