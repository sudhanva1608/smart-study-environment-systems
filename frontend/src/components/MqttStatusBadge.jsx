import { ShieldCheck, Cpu, Wifi } from 'lucide-react';
import { getForecastModels, getForecastMethodDetails } from '../forecastModels';

export default function MqttStatusBadge({ mqttStatus, stats, forecastData }) {
  const isConnected = mqttStatus?.connected ?? false;
  const forecastModels = getForecastModels(forecastData?.latest?.methods);
  const analysisLabel = forecastModels.length ? `Rules alerts · ML forecast: ${forecastModels.join(' + ')}` : 'Rules alerts · ML forecast pending';

  return (
    <div className="mqtt-status-banner">
      <div className="status-item">
        <div className={`status-indicator ${isConnected ? 'online' : 'offline'}`} />
        <Wifi size={16} className="icon" />
        <span className="status-label">MQTT STATUS:</span>
        <span className={`status-badge ${isConnected ? 'sync-active' : ''}`}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      <div className="status-item">
        <ShieldCheck size={16} className="icon" />
        <span className="status-label">LOCAL HISTORY:</span>
        <span className="status-badge sync-active">SQLite ({stats?.reading_count || 0} today)</span>
      </div>

      <div className="status-item">
        <Cpu size={16} className="icon" />
        <span className="status-label">ANALYSIS:</span>
        <span className="status-badge ml-active" title={getForecastMethodDetails(forecastData?.latest?.methods)}>{analysisLabel}</span>
      </div>
    </div>
  );
}
