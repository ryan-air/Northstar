import { useStore } from '../lib/store';

export function LeftPanel() {
  const snapshot = useStore((s) => s.snapshot);
  const selectedId = useStore((s) => s.selectedId);
  const vessels = snapshot?.vessels ?? [];
  const vessel = vessels.find((v) => v.entity_id === selectedId);
  const m = snapshot?.metrics;
  const live = snapshot?.live;
  const liveOk = live?.digitraffic.status === 'ok' || live?.digitraffic.status === 'degraded';
  const liveList = snapshot?.live_vessels ?? [];
  const fullstackId = snapshot?.lab?.fullstack_entity_id ?? snapshot?.lab?.signed_entity_id;
  const fullstackVessel = vessels.find((v) => v.entity_id === fullstackId);

  return (
    <aside className="panel">
      <div className="panel-title">Full-stack Lab vessel</div>
      <div className={`live-card ${fullstackId ? 'ok' : 'down'}`}>
        <div className="live-card-head">
          <strong>Complete evidence pack</strong>
          <span className="origin-tag lab">RF+AoA</span>
        </div>
        <div className="muted" style={{ fontSize: 11, lineHeight: 1.35 }}>
          Instrumented historical vessel: signed telemetry + OSNMA ICD + dual-antenna lab IQ /
          AoA. Select it to see full coverage.
        </div>
        {fullstackId && (
          <button
            type="button"
            className={`live-row ${selectedId === fullstackId ? 'active' : ''}`}
            style={{ marginTop: 8, width: '100%' }}
            onClick={() => useStore.getState().selectVessel(fullstackId)}
          >
            <span className="name">
              {fullstackVessel?.name ?? fullstackId}{' '}
              <span className="origin-tag live">FULL-STACK</span>
            </span>
            <span className={`band ${fullstackVessel?.trust.trust_band ?? ''}`}>
              {fullstackVessel?.trust.trust_score ?? '—'}
            </span>
          </button>
        )}
        {snapshot?.lab?.rf_aoa_status && (
          <div
            className={`origin-tag ${snapshot.lab.rf_aoa_status === 'pass' ? 'live' : 'lab'}`}
            style={{ marginTop: 8 }}
          >
            AoA: {snapshot.lab.rf_aoa_status}
            {typeof snapshot.lab.rf_summary?.cluster_score === 'number'
              ? ` · cluster ${Number(snapshot.lab.rf_summary.cluster_score).toFixed(2)}`
              : ''}
          </div>
        )}
      </div>

      <div className="panel-title">Hist Lab</div>
      <div
        className={`live-card ${snapshot?.lab?.mode === 'historical_replay' ? 'ok' : 'down'}`}
      >
        <div className="live-card-head">
          <strong>
            {snapshot?.lab?.mode === 'historical_replay'
              ? 'Digitraffic replay'
              : snapshot?.lab?.mode === 'synthetic_fallback'
                ? 'Synthetic fallback'
                : 'Lab starting…'}
          </strong>
          <span className="mono">{snapshot?.lab?.vessel_count ?? 0} ships</span>
        </div>
        <div className="muted" style={{ fontSize: 11, lineHeight: 1.35 }}>
          {snapshot?.lab?.note ??
            'Lab uses recorded Digitraffic AIS. Attack buttons are synthetic overlays only.'}
        </div>
        {snapshot?.lab?.osnma_protocol_status && (
          <div
            className={`origin-tag ${snapshot.lab.osnma_protocol_status === 'authenticated' ? 'live' : 'lab'}`}
            style={{ marginTop: 8 }}
          >
            OSNMA protocol:{' '}
            {snapshot.lab.osnma_protocol_status === 'authenticated'
              ? 'ICD demo → fullstack only'
              : snapshot.lab.osnma_protocol_status}
          </div>
        )}
        {snapshot?.lab?.recorder?.last_poll_at && (
          <div className="mono muted" style={{ fontSize: 10, marginTop: 6 }}>
            Recorder {snapshot.lab.recorder.status} · last +
            {snapshot.lab.recorder.last_count} @ {snapshot.lab.recorder.last_poll_at.slice(11, 19)}
          </div>
        )}
      </div>

      <div className="panel-title">Live AIS</div>
      <div className={`live-card ${liveOk ? 'ok' : 'down'}`}>
        <div className="live-card-head">
          <strong>{liveOk ? 'Connected' : live?.digitraffic.status ?? 'Starting…'}</strong>
          <span className="mono">{live?.vessel_count ?? 0} ships</span>
        </div>
        <div className="muted" style={{ fontSize: 11, lineHeight: 1.35 }}>
          Public AIS — partial coverage (kinematics/geo). No device identity, OSNMA, or AoA on
          Digitraffic streams.
        </div>
        {live?.digitraffic.last_updated && (
          <div className="mono muted" style={{ fontSize: 10, marginTop: 6 }}>
            Updated {live.digitraffic.last_updated}
          </div>
        )}
        {live?.digitraffic.last_error && (
          <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
            {live.digitraffic.last_error}
          </div>
        )}
        {live?.aisstream.reason && (
          <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
            AISStream: {live.aisstream.status} — {live.aisstream.reason}
          </div>
        )}
      </div>
      {liveList.length > 0 && (
        <div className="live-list">
          {liveList.slice(0, 12).map((v) => (
            <button
              key={v.entity_id}
              type="button"
              className={`live-row ${selectedId === v.entity_id ? 'active' : ''}`}
              onClick={() => useStore.getState().selectVessel(v.entity_id)}
            >
              <span className="name">{v.name ?? v.entity_id}</span>
              <span className={`band ${v.trust.trust_band}`}>{v.trust.trust_score}</span>
            </button>
          ))}
          {liveList.length > 12 && (
            <div className="muted" style={{ fontSize: 10, padding: '4px 0' }}>
              +{liveList.length - 12} more live vessels
            </div>
          )}
        </div>
      )}

      <div className="panel-title">Fleet metrics</div>
      <div className="metrics">
        <div className="metric-card">
          <div className="n">{m?.vessels_monitored ?? 0}</div>
          <div className="l">Monitored</div>
        </div>
        <div className="metric-card">
          <div className="n" style={{ color: 'var(--suspicious)' }}>
            {m?.high_risk_vessels ?? 0}
          </div>
          <div className="l">High risk</div>
        </div>
        <div className="metric-card">
          <div className="n" style={{ color: 'var(--danger)' }}>
            {m?.active_alerts ?? 0}
          </div>
          <div className="l">Active alerts</div>
        </div>
        <div className="metric-card">
          <div className="n">{m?.average_evidence_coverage?.toFixed(0) ?? 0}%</div>
          <div className="l">Avg coverage</div>
        </div>
      </div>

      <div className="panel-title">Selected vessel trust</div>
      <div className="gauge-wrap">
        <div className="trust-gauge">
          <div className={`trust-score ${vessel?.trust.trust_band ?? ''}`}>
            {vessel?.trust.trust_score ?? '—'}
          </div>
          <div className="band-label">{vessel?.trust.trust_band ?? 'no selection'}</div>
        </div>
        {vessel?.origin && (
          <div className={`origin-tag ${vessel.origin}`}>
            {vessel.origin === 'live'
              ? 'LIVE AIS'
              : snapshot?.lab?.mode === 'historical_replay'
                ? 'HIST REPLAY'
                : 'LAB / SYN'}
          </div>
        )}
        <div style={{ marginTop: 8 }} className="muted">
          Evidence coverage {vessel?.trust.evidence_coverage?.toFixed(0) ?? 0}% (
          {vessel?.trust.coverage_band ?? '—'}) · {vessel?.trust.available_checks ?? 0}/
          {vessel?.trust.expected_checks ?? 0} checks
        </div>
        <div className="coverage-bar">
          <span style={{ width: `${vessel?.trust.evidence_coverage ?? 0}%` }} />
        </div>
        <p className="muted" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.4 }}>
          Trust is a prototype integrity estimate (0–100), not a probability that the position is
          genuine. Live AIS still lacks RF/OSNMA/IMU evidence layers.
        </p>
      </div>
    </aside>
  );
}
