"""Local JSON-lines inference worker; uses standard-library IPC and local artifacts."""
import json
import sys
from forecast_ml import predict

for line in sys.stdin:
    try:
        request = json.loads(line)
        response = predict(request.get("readings", []))
    except Exception as error:
        response = {"status": "unavailable", "reason": f"Forecast error: {type(error).__name__}."}
    sys.stdout.write(json.dumps(response, allow_nan=False) + "\n")
    sys.stdout.flush()
