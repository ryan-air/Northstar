import { useStore } from '../lib/store';
import type { ViewMode } from '../lib/types';

export function TopBar() {
  const snapshot = useStore((s) => s.snapshot);
  const connected = useStore((s) => s.connected);
  const selectedId = useStore((s) => s.selectedId);
  const setViewMode = useStore((s) => s.setViewMode);
  const vessel = snapshot?.vessels?.find((v) => v.entity_id === selectedId);
  const alerts = snapshot?.alerts.filter((a) => a.severity !== 'info') ?? [];
  const live = snapshot?.live;
  const liveOk = live?.digitraffic.status === 'ok' || live?.digitraffic.status === 'degraded';
  const mode = snapshot?.view_mode ?? 'both';

  return (
    <header className="top-bar">
      <div className="brand">
        <div className="brand-mark">NORTHSTAR</div>
        <div className="brand-sub">Integrity</div>
      </div>
      <div className="mode-badge">{snapshot?.monitoring_label ?? 'CONNECTING'}</div>
      <div className="view-toggle" title="Separate live Digitraffic AIS from lab attack demos">
        {(['live', 'both', 'lab'] as ViewMode[]).map((m) => (
          <button
            key={m}
            type="button"
            className={mode === m ? 'active' : ''}
            onClick={() => void setViewMode(m)}
            title={
              m === 'lab'
                ? 'Recorded Digitraffic AIS replay (+ attack overlays)'
                : m === 'live'
                  ? 'Live Digitraffic AIS'
                  : 'Live + historical lab'
            }
          >
            {m === 'live' ? 'Live' : m === 'lab' ? 'Hist Lab' : 'Both'}
          </button>
        ))}
      </div>
      <div className="instruments">
        <div className="instrument">
          <div className="label">HDG</div>
          <div className="value">
            {vessel?.heading_deg != null ? vessel.heading_deg.toFixed(1) : '—'}°
          </div>
          <div className="src">GYRO / DR</div>
        </div>
        <div className="instrument">
          <div className="label">COG</div>
          <div className="value">
            {vessel?.course_over_ground_deg != null
              ? vessel.course_over_ground_deg.toFixed(1)
              : '—'}
            °
          </div>
          <div className="src">GNSS</div>
        </div>
        <div className="instrument">
          <div className="label">SOG</div>
          <div className="value">
            {vessel?.speed_over_ground_knots != null
              ? vessel.speed_over_ground_knots.toFixed(1)
              : '—'}{' '}
            kn
          </div>
          <div className="src">GNSS</div>
        </div>
        <div className="instrument">
          <div className="label">TRUST</div>
          <div className="value">{vessel?.trust.trust_score ?? '—'}</div>
          <div className="src">{vessel?.trust.trust_band?.toUpperCase() ?? ''}</div>
        </div>
      </div>
      <div className="top-right">
        <div
          className={`live-pill ${liveOk ? 'on' : 'off'}`}
          title={live?.note ?? 'Live AIS'}
        >
          {liveOk
            ? `LIVE ${live?.vessel_count ?? 0}`
            : live?.digitraffic.status === 'connecting'
              ? 'LIVE…'
              : 'LIVE OFF'}
        </div>
        <div className="mono muted" style={{ fontSize: 11 }}>
          {snapshot?.lab?.mode === 'historical_replay' ? 'REPLAY' : 'LAB'}{' '}
          {snapshot?.sim_time?.slice(11, 19) ?? '--:--:--'} UTC
        </div>
        <div className="feed-leds" title="Feed health">
          {Object.entries(snapshot?.feed_health ?? {}).map(([k, v]) => (
            <div key={k} className={`led ${v}`} title={`${k}: ${v}`} />
          ))}
        </div>
        <div className={`alert-tri ${alerts.length ? '' : 'quiet'}`} title={`${alerts.length} alerts`}>
          ⚠
        </div>
        <div className="mono muted" style={{ fontSize: 10 }}>
          {connected ? 'WS' : 'POLL'}
        </div>
      </div>
    </header>
  );
}
