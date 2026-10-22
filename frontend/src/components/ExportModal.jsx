import { useState, useEffect, useCallback } from 'react';
import {
  Download,
  Calendar,
  Clock,
  X,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Filter
} from 'lucide-react';

function padZero(n) {
  return String(n).padStart(2, '0');
}

/**
 * Format a Date object to local YYYY-MM-DDTHH:mm string for datetime-local input
 */
function toLocalInputString(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${padZero(d.getMonth() + 1)}-${padZero(d.getDate())}T${padZero(d.getHours())}:${padZero(d.getMinutes())}`;
}

export default function ExportModal({ isOpen, onClose, backendUrl = '' }) {
  const [preset, setPreset] = useState('1h'); // '15m' | '1h' | '6h' | 'today' | 'all' | 'custom'
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [loadingCount, setLoadingCount] = useState(false);
  const [exportCount, setExportCount] = useState(null);
  const [dataBounds, setDataBounds] = useState({ earliest: null, latest: null, total: 0 });
  const [downloading, setDownloading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const rangeInvalid = Boolean(startTime && endTime && new Date(startTime).getTime() > new Date(endTime).getTime());

  // Fetch overall bounds when modal opens
  const fetchOverallBounds = useCallback(async () => {
    try {
      const res = await fetch(`${backendUrl}/api/export/count`);
      if (res.ok) {
        const json = await res.json();
        setDataBounds({
          earliest: json.earliest,
          latest: json.latest,
          total: json.count || 0
        });
      }
    } catch (err) {
      console.warn('Could not fetch export count bounds:', err);
    }
  }, [backendUrl]);

  // Apply a preset window
  const applyPreset = useCallback((presetKey, anchorDate = null) => {
    setPreset(presetKey);
    setErrorMsg('');
    setSuccessMsg('');

    const now = anchorDate ? new Date(anchorDate) : new Date();

    if (presetKey === 'all') {
      setStartTime('');
      setEndTime('');
      return;
    }

    if (presetKey === '15m') {
      const start = new Date(now.getTime() - 15 * 60 * 1000);
      setStartTime(toLocalInputString(start));
      setEndTime(toLocalInputString(now));
      return;
    }

    if (presetKey === '1h') {
      const start = new Date(now.getTime() - 60 * 60 * 1000);
      setStartTime(toLocalInputString(start));
      setEndTime(toLocalInputString(now));
      return;
    }

    if (presetKey === '6h') {
      const start = new Date(now.getTime() - 6 * 60 * 60 * 1000);
      setStartTime(toLocalInputString(start));
      setEndTime(toLocalInputString(now));
      return;
    }

    if (presetKey === 'today') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      setStartTime(toLocalInputString(start));
      setEndTime(toLocalInputString(now));
      return;
    }
  }, []);

  // Initialize preset on modal open
  useEffect(() => {
    if (isOpen) {
      // Opening the dialog is a user action; initialize the relative preset for its new session.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchOverallBounds();
      applyPreset('1h');
    }
  }, [isOpen, fetchOverallBounds, applyPreset]);

  // Check count whenever startTime or endTime changes
  useEffect(() => {
    if (!isOpen || rangeInvalid) return;

    const timer = setTimeout(async () => {
      setLoadingCount(true);
      try {
        const params = new URLSearchParams();
        if (startTime) params.append('from', new Date(startTime).toISOString());
        if (endTime) params.append('to', new Date(endTime).toISOString());
        params.append('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata');

        const res = await fetch(`${backendUrl}/api/export/count?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          setExportCount(data.count ?? 0);
        } else {
          setExportCount(0);
        }
      } catch (err) {
        console.error('Count query error:', err);
      } finally {
        setLoadingCount(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [startTime, endTime, isOpen, backendUrl, rangeInvalid]);

  // Keyboard shortcut (Escape to close)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Handle manual start time change
  const handleStartTimeChange = (e) => {
    setPreset('custom');
    setStartTime(e.target.value);
  };

  // Handle manual end time change
  const handleEndTimeChange = (e) => {
    setPreset('custom');
    setEndTime(e.target.value);
  };

  // Set End Time to current instant
  const handleSetNow = () => {
    setPreset('custom');
    setEndTime(toLocalInputString(new Date()));
  };

  // Match full available bounds from stored data
  const handleFitDataBounds = () => {
    if (dataBounds.earliest && dataBounds.latest) {
      setPreset('custom');
      setStartTime(toLocalInputString(dataBounds.earliest));
      setEndTime(toLocalInputString(dataBounds.latest));
    }
  };

  // Trigger CSV export
  const handleDownload = async () => {
    if (startTime && endTime && new Date(startTime) > new Date(endTime)) {
      setErrorMsg('Start time cannot be after End time.');
      return;
    }

    setDownloading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const params = new URLSearchParams();
      if (startTime) params.append('from', new Date(startTime).toISOString());
      if (endTime) params.append('to', new Date(endTime).toISOString());
      params.append('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata');

      const url = `${backendUrl}/api/export?${params.toString()}`;
      const res = await fetch(url);

      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({}));
        throw new Error(errorJson.error || `Export failed with status ${res.status}`);
      }

      // Extract filename from Content-Disposition header if available
      let filename = 'sses_sensor_readings.csv';
      const disposition = res.headers.get('content-disposition');
      if (disposition && disposition.includes('filename=')) {
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match && match[1]) filename = match[1];
      }

      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);

      setSuccessMsg(`✓ Successfully downloaded ${exportCount ?? ''} readings to ${filename}`);
      setTimeout(() => {
        onClose();
      }, 1600);
    } catch (err) {
      console.error('Download error:', err);
      setErrorMsg(err.message || 'Failed to download CSV. Check connection.');
    } finally {
      setDownloading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="export-modal-backdrop" onClick={onClose}>
      <div
        className="export-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-modal-title"
      >
        {/* Modal Header */}
        <div className="export-modal-header">
          <div className="export-modal-title-wrap">
            <div className="export-modal-icon-badge">
              <FileSpreadsheet size={20} className="icon-cyan" />
            </div>
            <div>
              <h2 id="export-modal-title" className="export-modal-title">
                Export Sensor Data (CSV)
              </h2>
              <p className="export-modal-subtitle">
                Download readings for a stipulated time window or predefined duration
              </p>
            </div>
          </div>
          <button
            className="export-modal-close-btn"
            onClick={onClose}
            aria-label="Close export dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="export-modal-body">
          {/* Quick Stipulation Presets */}
          <div className="export-section">
            <label className="export-section-label">
              <Clock size={13} style={{ marginRight: 6 }} />
              Quick Stipulated Presets
            </label>
            <div className="export-preset-pills">
              <button
                type="button"
                className={`preset-pill ${preset === '15m' ? 'active' : ''}`}
                onClick={() => applyPreset('15m')}
              >
                Last 15 Mins
              </button>
              <button
                type="button"
                className={`preset-pill ${preset === '1h' ? 'active' : ''}`}
                onClick={() => applyPreset('1h')}
              >
                Last 1 Hour
              </button>
              <button
                type="button"
                className={`preset-pill ${preset === '6h' ? 'active' : ''}`}
                onClick={() => applyPreset('6h')}
              >
                Last 6 Hours
              </button>
              <button
                type="button"
                className={`preset-pill ${preset === 'today' ? 'active' : ''}`}
                onClick={() => applyPreset('today')}
              >
                Today
              </button>
              <button
                type="button"
                className={`preset-pill ${preset === 'all' ? 'active' : ''}`}
                onClick={() => applyPreset('all')}
              >
                All Records
              </button>
              <button
                type="button"
                className={`preset-pill ${preset === 'custom' ? 'active' : ''}`}
                onClick={() => setPreset('custom')}
              >
                Custom Range
              </button>
            </div>
          </div>

          {/* Stipulated Time Form */}
          <div className="export-section">
            <div className="export-section-header">
              <label className="export-section-label">
                <Calendar size={13} style={{ marginRight: 6 }} />
                Stipulated Time Window
              </label>
              {dataBounds.earliest && dataBounds.latest && (
                <button
                  type="button"
                  className="export-bounds-link"
                  onClick={handleFitDataBounds}
                  title="Align range to available stored recordings"
                >
                  <Filter size={11} style={{ marginRight: 4 }} />
                  Fit To Stored Data
                </button>
              )}
            </div>

            <div className="export-time-grid">
              {/* Start Time */}
              <div className="export-time-field">
                <span className="export-field-tag">START TIME (FROM)</span>
                <div className="export-input-wrap">
                  <input
                    type="datetime-local"
                    className="export-datetime-input"
                    value={startTime}
                    onChange={handleStartTimeChange}
                    placeholder="YYYY-MM-DDTHH:mm"
                  />
                  {startTime && (
                    <button
                      type="button"
                      className="export-field-clear"
                      onClick={() => {
                        setStartTime('');
                        setPreset('custom');
                      }}
                      title="Clear Start Time"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>

              {/* End Time */}
              <div className="export-time-field">
                <div className="export-field-header-row">
                  <span className="export-field-tag">END TIME (TO)</span>
                  <button
                    type="button"
                    className="export-quick-now"
                    onClick={handleSetNow}
                    title="Set to Current Local Time"
                  >
                    Set to Now
                  </button>
                </div>
                <div className="export-input-wrap">
                  <input
                    type="datetime-local"
                    className="export-datetime-input"
                    value={endTime}
                    onChange={handleEndTimeChange}
                    placeholder="YYYY-MM-DDTHH:mm"
                  />
                  {endTime && (
                    <button
                      type="button"
                      className="export-field-clear"
                      onClick={() => {
                        setEndTime('');
                        setPreset('custom');
                      }}
                      title="Clear End Time"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Record Count & Status Preview Card */}
          <div className="export-status-card">
            <div className="export-status-row">
              <span className="export-status-label">Readings Matching Window:</span>
              <span className="export-status-badge">
                {loadingCount ? (
                  <span className="count-spinner">
                    <RefreshCw size={12} className="spin-icon" /> Checking...
                  </span>
                ) : exportCount !== null ? (
                  <span className={exportCount > 0 ? 'count-ok' : 'count-zero'}>
                    {exportCount} {exportCount === 1 ? 'reading' : 'readings'}
                  </span>
                ) : (
                  '—'
                )}
              </span>
            </div>

            {/* Time span description */}
            <div className="export-timerange-summary">
              {!startTime && !endTime ? (
                <span>All recorded history from storage will be included ({dataBounds.total} total readings available).</span>
              ) : (
                <span>
                  From: <strong>{startTime ? new Date(startTime).toLocaleString() : 'Earliest Recorded'}</strong>
                  {' → '}
                  To: <strong>{endTime ? new Date(endTime).toLocaleString() : 'Now / Latest'}</strong>
                </span>
              )}
            </div>

            {/* Included Fields List */}
            <div className="export-fields-preview">
              <span className="fields-title">Included CSV Fields:</span>
              <div className="fields-tags">
                <span className="field-tag" style={{ borderColor: 'var(--cyan-dim)', color: 'var(--cyan)' }}>Timestamp</span>
                <span className="field-tag">Temperature (°C)</span>
                <span className="field-tag">Humidity (%)</span>
                <span className="field-tag">Light (ADC)</span>
                <span className="field-tag">Air Quality (ADC)</span>
                <span className="field-tag">Status</span>
              </div>
              <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-secondary)' }}>
                <span>Recorded timestamps are exported as stored; no historical times are generated.</span>
              </div>
            </div>
          </div>

          {/* Error Banner */}
          {(rangeInvalid ? 'Start time must be before or equal to End time.' : errorMsg) && (
            <div className="export-alert error">
              <AlertTriangle size={15} />
              <span>{rangeInvalid ? 'Start time must be before or equal to End time.' : errorMsg}</span>
            </div>
          )}

          {/* Success Banner */}
          {successMsg && (
            <div className="export-alert success">
              <CheckCircle2 size={15} />
              <span>{successMsg}</span>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="export-modal-footer">
          <button
            type="button"
            className="export-btn-cancel"
            onClick={onClose}
            disabled={downloading}
          >
            Cancel
          </button>

          <button
            type="button"
            className="export-btn-confirm"
            onClick={handleDownload}
            disabled={downloading || rangeInvalid || (exportCount === 0 && (startTime || endTime))}
          >
            {downloading ? (
              <>
                <RefreshCw size={14} className="spin-icon" />
                Generating CSV...
              </>
            ) : (
              <>
                <Download size={14} />
                Download Stipulated CSV
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
