import React from 'react';
import { ShieldCheck, Cpu, Wifi } from 'lucide-react';

export default function MqttStatusBadge({ mqttStatus, stats }) {
  const isConnected = mqttStatus?.connected ?? true;

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
        <span className="status-label">CLOUD DB:</span>
        <span className="status-badge sync-active">Synced ({stats?.reading_count || 0} Records)</span>
      </div>

      <div className="status-item">
        <Cpu size={16} className="icon" />
        <span className="status-label">ML ENGINE:</span>
        <span className="status-badge ml-active">Ridge Regressor Active</span>
      </div>
    </div>
  );
}
