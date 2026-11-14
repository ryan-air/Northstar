import { useStore } from '../lib/store';

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

  return (
    <aside className="panel">
      <div className="panel-title">Fleet</div>
      <div className="metrics">
        <div className="metric-card">
          <div className="n">{m?.vessels_monitored ?? 0}</div>
          <div className="l">Monitored</div>
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
        <div className="metric-card">
          <div className="n">{m?.average_evidence_coverage?.toFixed(0) ?? 0}%</div>
          <div className="l">Avg Coverage</div>
        </div>
        <div className="metric-card">
          <div className="n">{live?.vessel_count ?? 0}</div>
          <div className="l">Live Ships</div>
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
              <div className={`origin-tag ${vessel.origin}`} style={{ marginTop: 8 }}>
                {vessel.origin === 'live' ? 'LIVE AIS' : 'HIST LAB'}
              </div>
            )}
            <div className="coverage-bar" style={{ marginTop: 8 }}>
              <span style={{ width: `${vessel.trust.evidence_coverage ?? 0}%` }} />
            </div>
            <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
              {vessel.trust.evidence_coverage.toFixed(0)}% ·{' '}
              {vessel.trust.available_checks}/{vessel.trust.expected_checks} checks
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

      <div className="panel-title">Vessels</div>
      <div className="vessel-list">
        {sortedVessels.map((v) => (
          <button
            key={v.entity_id}
            type="button"
            className={`live-row${selectedId === v.entity_id ? ' active' : ''}`}
            onClick={() => useStore.getState().selectVessel(v.entity_id)}
          >
            <span className="name">{v.name ?? v.entity_id}</span>
            <span className={`band ${v.trust.trust_band}`}>{v.trust.trust_score}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
