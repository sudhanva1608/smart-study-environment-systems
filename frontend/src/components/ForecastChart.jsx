import React from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ReferenceLine
} from 'recharts';

// Custom tooltip that only shows relevant fields
const CustomTooltip = ({ active, payload, label, unit }) => {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{
      background: '#0e0e1a',
      border: '1px solid #1a1a2e',
      borderRadius: 8,
      padding: '10px 14px',
      fontFamily: "'Share Tech Mono', monospace",
      fontSize: 12,
    }}>
      <p style={{ color: '#6b7280', marginBottom: 6, letterSpacing: 1 }}>{label}</p>
      {payload.map((entry) =>
        entry.value !== null && entry.value !== undefined ? (
          <p key={entry.name} style={{ color: entry.color, margin: '3px 0' }}>
            {entry.name}: <strong>{entry.value.toFixed(1)}{unit}</strong>
          </p>
        ) : null
      )}
    </div>
  );
};

export default function ForecastChart({ history, predictions, metric, title, unit, color }) {
  if (!history || !history[metric]) return null;

  const raw = history[metric];

  // Only show last 20 data points so it doesn't look cluttered
  const slice = raw.slice(-20);

  const historicalData = slice.map((tick, i) => ({
    time: tick.time,
    Actual: typeof tick.value === 'number' ? parseFloat(tick.value.toFixed(1)) : null,
    Forecast: null,
    isBoundary: false,
  }));

  const combinedData = [...historicalData];

  if (predictions?.forecast_15m) {
    const lastVal = historicalData[historicalData.length - 1]?.Actual ?? null;

    // Mark last historical point as boundary bridge so forecast line connects
    combinedData[combinedData.length - 1].Forecast = lastVal;
    combinedData[combinedData.length - 1].isBoundary = true;

    combinedData.push({
      time: '+15m',
      Actual: null,
      Forecast: parseFloat((predictions.forecast_15m[metric] ?? 0).toFixed(1)),
    });
    combinedData.push({
      time: '+30m',
      Actual: null,
      Forecast: parseFloat((predictions.forecast_30m[metric] ?? 0).toFixed(1)),
    });
    combinedData.push({
      time: '+60m',
      Actual: null,
      Forecast: parseFloat((predictions.forecast_60m[metric] ?? 0).toFixed(1)),
    });
  }

  // Find boundary index (where history ends and forecast starts)
  const boundaryTime = combinedData.find(d => d.isBoundary)?.time;

  return (
    <div className="forecast-chart-card">
      <div className="chart-header">
        <h4>{title} Trend &amp; AI Forecast</h4>
        <span className="chart-badge">Historical + ML Horizon</span>
      </div>
      <div className="chart-body" style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={combinedData} margin={{ top: 10, right: 16, left: -10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" vertical={false} />
            <XAxis
              dataKey="time"
              stroke="#3d4452"
              tick={{ fontSize: 10, fill: '#6b7280', fontFamily: 'Share Tech Mono' }}
              interval="preserveStartEnd"
              tickLine={false}
            />
            <YAxis
              stroke="#3d4452"
              tick={{ fontSize: 10, fill: '#6b7280', fontFamily: 'Share Tech Mono' }}
              unit={unit}
              domain={['dataMin - 1', 'dataMax + 1']}
              tickLine={false}
              axisLine={false}
              width={55}
            />
            <Tooltip content={<CustomTooltip unit={unit} />} />
            <Legend
              wrapperStyle={{ fontSize: 11, fontFamily: 'Share Tech Mono', paddingTop: 8 }}
              iconType="line"
            />

            {/* Divider line between historical & forecast */}
            {boundaryTime && (
              <ReferenceLine
                x={boundaryTime}
                stroke="#ffd60a44"
                strokeDasharray="4 4"
                label={{
                  value: 'NOW',
                  position: 'top',
                  fill: '#ffd60a',
                  fontSize: 9,
                  fontFamily: 'Share Tech Mono',
                }}
              />
            )}

            {/* Actual historical line — clean, no dots */}
            <Line
              type="monotone"
              dataKey="Actual"
              stroke={color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 5, fill: color, stroke: '#0e0e1a', strokeWidth: 2 }}
              isAnimationActive={false}
              connectNulls={false}
              name="Actual"
            />

            {/* Forecast dashed line — only 3-4 points, clearly distinct */}
            <Line
              type="monotone"
              dataKey="Forecast"
              stroke="#ffd60a"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={{ r: 4, fill: '#ffd60a', stroke: '#0e0e1a', strokeWidth: 2 }}
              activeDot={{ r: 6 }}
              isAnimationActive={false}
              connectNulls={true}
              name="ML Forecast"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
