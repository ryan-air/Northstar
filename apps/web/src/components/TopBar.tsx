import { useStore } from '../lib/store';
import type { ViewMode } from '../lib/types';

const MODE_DESC: Record<ViewMode, string> = {
  live: 'LIVE AIS · Digitraffic',
  lab: 'Lab · recorded + simulated ships',
  both: 'Live + Lab',
};

export function TopBar() {
  const snapshot = useStore((s) => s.snapshot);
  const selectedId = useStore((s) => s.selectedId);
  const setViewMode = useStore((s) => s.setViewMode);
  const vessel = snapshot?.vessels?.find((v) => v.entity_id === selectedId);
  const alerts = snapshot?.alerts.filter((a) => a.severity !== 'info') ?? [];
  const mode = snapshot?.view_mode ?? 'lab';

  return (
    <header className="top-bar">
      {/* Left zone */}
      <div className="top-left">
        <div className="brand">
          <div className="brand-mark">NORTHSTAR</div>
          <div className="brand-sub">Integrity</div>
        </div>
        {!snapshot && <div className="mode-badge">CONNECTING</div>}
      </div>

      {/* Center zone — anchored instruments */}
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

      {/* Right zone */}
      <div className="top-right">
        <div className="view-toggle" title="Switch between live AIS and the Lab">
          {(['live', 'lab'] as ViewMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={mode === m ? 'active' : ''}
              onClick={() => void setViewMode(m)}
            >
              {m === 'live' ? 'Live' : 'Lab'}
            </button>
          ))}
        </div>
        <div className="mode-desc">{MODE_DESC[mode]}</div>
        <div
          className={`alert-tri ${alerts.length ? '' : 'quiet'}`}
          title={`${alerts.length} alerts`}
        >
          ⚠
        </div>
        <div className="mono muted" style={{ fontSize: 11 }}>
          {snapshot?.sim_time?.slice(11, 19) ?? '--:--:--'} UTC
        </div>
      </div>
    </header>
  );
}
