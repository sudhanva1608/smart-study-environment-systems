import React from 'react';
import { Brain, Sparkles, Clock, AlertTriangle, CheckCircle2, Thermometer, Droplets, Wind } from 'lucide-react';

export default function MLPredictionCard({ predictions }) {
  if (!predictions) {
    return (
      <div className="ml-card-skeleton">
        <Brain className="animate-spin" />
        <span>Initializing ML Forecast Engine...</span>
      </div>
    );
  }

  const { forecast_15m, forecast_30m, forecast_60m, recommendation, confidenceScore, modelAlgorithm } = predictions;

  const horizons = [
    { title: '15 Mins Horizon', data: forecast_15m },
    { title: '30 Mins Horizon', data: forecast_30m },
    { title: '60 Mins Horizon', data: forecast_60m },
  ];

  const getStatusBadge = (status) => {
    switch (status) {
      case 'Ideal':
        return <span className="horizon-badge status-ideal">Ideal</span>;
      case 'Moderate':
        return <span className="horizon-badge status-moderate">Moderate</span>;
      default:
        return <span className="horizon-badge status-poor">Poor</span>;
    }
  };

  return (
    <div className="ml-prediction-section">
      <div className="ml-header">
        <div className="ml-title-group">
          <div className="ml-icon-glow">
            <Brain size={24} />
          </div>
          <div>
            <h3>AI Future Predictions Engine</h3>
            <span className="ml-subtitle">{modelAlgorithm || 'Scikit-Learn Time-Series Forecaster'} • {confidenceScore}% Confidence</span>
          </div>
        </div>
        <div className="ml-live-chip">
          <Sparkles size={14} />
          <span>Real-time Predictive Analytics</span>
        </div>
      </div>

      <div className="recommendation-box">
        <div className="recommendation-icon">
          <AlertTriangle size={20} className="pulse-icon" />
        </div>
        <div className="recommendation-content">
          <h4>AI Smart Comfort Advisory</h4>
          <p>{recommendation || 'Environmental trends remain optimal for focus and productivity.'}</p>
        </div>
      </div>

      <div className="horizons-grid">
        {horizons.map((item, idx) => (
          <div key={idx} className="horizon-card">
            <div className="horizon-card-header">
              <div className="horizon-time">
                <Clock size={16} />
                <span>{item.title}</span>
              </div>
              {getStatusBadge(item.data?.status)}
            </div>

            <div className="horizon-metrics">
              <div className="metric-row">
                <div className="metric-meta">
                  <Thermometer size={16} className="metric-icon temp-icon" />
                  <span>Temperature</span>
                </div>
                <span className="metric-val">{item.data?.temperature ?? '--'}°C</span>
              </div>

              <div className="metric-row">
                <div className="metric-meta">
                  <Droplets size={16} className="metric-icon hum-icon" />
                  <span>Humidity</span>
                </div>
                <span className="metric-val">{item.data?.humidity ?? '--'}%</span>
              </div>

              <div className="metric-row">
                <div className="metric-meta">
                  <Wind size={16} className="metric-icon aq-icon" />
                  <span>Air Quality</span>
                </div>
                <span className="metric-val">{item.data?.airQuality ?? '--'} ADC</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
