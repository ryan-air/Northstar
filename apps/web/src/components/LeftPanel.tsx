import { useEffect } from 'react';
import { useStore } from '../lib/store';
import { ROLE_LABEL, roleOf } from '../lib/roles';

const hhmm = (iso: string) => iso.slice(11, 16);

export function LeftPanel() {
  const snapshot = useStore((s) => s.snapshot);
  const selectedId = useStore((s) => s.selectedId);
  const vessels = snapshot?.vessels ?? [];
  const m = snapshot?.metrics;
  const live = snapshot?.live;

  const vessel = vessels.find((v) => v.entity_id === selectedId);

  // Ascending trust score (lowest / worst first); entity_id breaks ties for a
  // deterministic order.
  const sortedVessels = [...vessels].sort((a, b) => {
    const d = (a.trust.trust_score ?? 0) - (b.trust.trust_score ?? 0);
    return d !== 0 ? d : a.entity_id.localeCompare(b.entity_id);
  });

  const clearSelection = () => useStore.setState({ selectedId: null });
  const labEvents = useStore((s) => s.labEvents);
  const labVesselName = useStore((s) => s.labVesselName);
  const labId = snapshot?.injection?.lab_vessel_id ?? null;
  useEffect(() => {
    if (labId) void useStore.getState().loadLabEvents();
  }, [labId]);
  const jump = async (iso: string) => {
    // Start a minute before the event so the approach is visible.
    const t = new Date(Date.parse(iso) - 60_000).toISOString();
    if ((await useStore.getState().seekLab(t)) && labId) useStore.getState().selectVessel(labId);
  };

  return (
    <aside className="panel">
      <div className="panel-title">Fleet</div>
      <div className="metrics">
        <div className="metric-card">
          <div className="n">{m?.vessels_monitored ?? 0}</div>
          <div className="l">Monitored</div>
        </div>
        <div className="metric-card">
          <div className="n">{live?.vessel_count ?? 0}</div>
          <div className="l">Live Ships</div>
        </div>
        <div className="metric-card">
          <div className="n" style={{ color: 'var(--suspicious)' }}>
            {m?.high_risk_vessels ?? 0}
          </div>
          <div className="l">High Risk</div>
        </div>
        <div className="metric-card">
          <div className="n" style={{ color: 'var(--danger)' }}>
            {m?.active_alerts ?? 0}
          </div>
          <div className="l">Alerts</div>
        </div>
        <div className="metric-card wide">
          <div className="n">{m?.average_evidence_coverage?.toFixed(0) ?? 0}%</div>
          <div className="l">Avg Coverage</div>
        </div>
      </div>

      {vessel && (
        <div className="vessel-detail">
          <div className="panel-title vessel-detail-header">
            <span>Selected vessel</span>
            <button type="button" className="clear-sel" onClick={clearSelection}>
              ✕
            </button>
          </div>
          <div className="gauge-wrap">
            <div className="trust-gauge">
              <div className={`trust-score ${vessel.trust.trust_band}`}>
                {vessel.trust.trust_score}
              </div>
              <div className="band-label">{vessel.trust.trust_band}</div>
            </div>
            {vessel.origin && (
              <div className={`origin-tag ${roleOf(vessel, snapshot)}`} style={{ marginTop: 8 }}>
                {ROLE_LABEL[roleOf(vessel, snapshot)]}
              </div>
            )}
            {vessel.trust.transponder_kind === 'non_vessel_transponder' && (
              <div
                className="origin-tag nonvessel"
                style={{ marginTop: 4 }}
                title={(vessel.trust.transponder_kind_reasons ?? []).join('; ')}
              >
                NOT A VESSEL (fixed / test unit)
              </div>
            )}
            <div className="coverage-bar" style={{ marginTop: 8 }}>
              <span style={{ width: `${vessel.trust.evidence_coverage ?? 0}%` }} />
            </div>
            <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
              {vessel.trust.evidence_coverage.toFixed(0)}% ·{' '}
              {vessel.trust.available_checks}/{vessel.trust.expected_checks} checks · verified{' '}
              {vessel.trust.verified_evidence_coverage?.toFixed(0) ?? '—'}% (live/recorded only)
            </div>
          </div>
          <div className="kv" style={{ padding: '0 12px 10px' }}>
            <div className="k">Name</div>
            <div className="v">{vessel.name ?? '—'}</div>
            <div className="k">Class</div>
            <div className="v">{vessel.vessel_class ?? '—'}</div>
            <div className="k">Position</div>
            <div className="v">
              {vessel.position.lat.toFixed(5)} N, {vessel.position.lon.toFixed(5)} E
            </div>
            <div className="k">Updated</div>
            <div className="v">{vessel.last_update}</div>
          </div>
          {vessel.trust.explanation && (
            <div className="explain" style={{ margin: '0 12px 10px' }}>
              {vessel.trust.explanation}
            </div>
          )}
        </div>
      )}

      {labId && labEvents.length > 0 && (
        <div className="lab-events">
          <div className="panel-title">Lab vessel events{labVesselName ? ` · ${labVesselName}` : ''}</div>
          <div className="lab-events-note">Flagged by the vessel's own receiver / RF captures (recorded data).</div>
          {labEvents.map((e) => (
            <div key={`${e.kind}-${e.start}`} className={`lab-event ${e.kind}`}>
              <span className="when mono">
                {hhmm(e.start)}–{hhmm(e.end)}
              </span>
              <span className="what">{e.detail}</span>
              <button type="button" className="jump" onClick={() => void jump(e.start)}>
                Jump
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="panel-title">Vessels</div>
      <div className="vessel-list">
        {sortedVessels.map((v) => (
          <button
            key={v.entity_id}
            type="button"
            className={`live-row${selectedId === v.entity_id ? ' active' : ''}`}
            onClick={() => useStore.getState().selectVessel(v.entity_id)}
          >
            <span className="name">
              {v.name ?? v.entity_id}
              {roleOf(v, snapshot) === 'simulated' && <span className="row-tag sim">SIM</span>}
              {roleOf(v, snapshot) === 'lab' && <span className="row-tag lab">LAB</span>}
            </span>
            <span className={`band ${v.trust.trust_band}`}>{v.trust.trust_score}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
