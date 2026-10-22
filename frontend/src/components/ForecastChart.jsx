import { memo, useMemo } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { prepareChartPoints } from '../chartData';

function ForecastChart({ history, metric, title, unit, color, sourceLabel = 'Recorded history' }) {
  const data = useMemo(() => prepareChartPoints(history?.[metric]), [history, metric]);
  const values = data.map(point => Number(point.value)).filter(Number.isFinite);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const span = high - low;
  const pad = span ? span * 0.08 : Math.max(Math.abs(high) * 0.01, 0.1);
  const decimals = metric === 'temperature' ? 1 : metric === 'humidity' ? 1 : 0;
  return (
    <div className="forecast-chart-card fade-in">
      <div className="chart-header">
        <h4>{title}</h4>
        <span className="chart-badge">{sourceLabel}</span>
      </div>
      <div className="chart-body">
        {data.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 10, right: 12, left: 4, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" vertical={false} />
              <XAxis dataKey="time" stroke="var(--text-muted)" tick={{ fontSize: 10, fill: 'var(--text-secondary)', fontFamily: 'Share Tech Mono' }} interval="preserveStartEnd" minTickGap={34} tickLine={false} />
              <YAxis stroke="var(--text-muted)" tick={{ fontSize: 10, fill: 'var(--text-secondary)', fontFamily: 'Share Tech Mono' }} tickFormatter={value => Number(value).toFixed(decimals)} domain={[low - pad, high + pad]} tickLine={false} axisLine={false} width={62} />
              <Tooltip labelFormatter={(_, payload) => payload?.[0]?.payload?.timestamp ? new Date(payload[0].payload.timestamp).toLocaleString() : _} formatter={(value) => [Number(value).toFixed(decimals) + unit, 'Observed']} />
              <Line type="monotone" dataKey="value" name="Observed" stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 5 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : <div className="empty-alerts">No readings in this time range.</div>}
      </div>
    </div>
  );
}

export default memo(ForecastChart);
