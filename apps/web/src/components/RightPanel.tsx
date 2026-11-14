import { useState } from 'react';
import { useStore } from '../lib/store';

export function RightPanel() {
  const [tab, setTab] = useState<'events' | 'evidence' | 'sources'>('events');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const snapshot = useStore((s) => s.snapshot);
  const selectedId = useStore((s) => s.selectedId);
  const vessel = snapshot?.vessels?.find((v) => v.entity_id === selectedId);
  const events = [...(snapshot?.timeline ?? [])].reverse();
  const selectedEvent = events.find((e) => e.id === selectedEventId) ?? null;

  return (
    <aside className="panel right">
      <div className="tabs">
        <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>
          Events
        </button>
        <button
          className={tab === 'evidence' ? 'active' : ''}
          onClick={() => setTab('evidence')}
        >
          Evidence
        </button>
        <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}>
          Sources
        </button>
      </div>

      {tab === 'events' && (
        <div className="tab-body events-tab">
          {snapshot?.feed_health && Object.keys(snapshot.feed_health).length > 0 && (
            <div className="feed-status-row">
              {Object.entries(snapshot.feed_health).map(([k, v]) => (
                <div key={k} className="feed-status-item">
                  <span className={`led ${v}`} />
                  <span>{k}</span>
                </div>
              ))}
            </div>
          )}

          {/* Pinned detail — stays put while the live feed scrolls below. */}
          {selectedEvent && (
            <div className="event-detail-pinned">
              <div className="event-detail-head">
                <strong>{selectedEvent.title}</strong>
                <button
                  type="button"
                  className="clear-sel"
                  onClick={() => setSelectedEventId(null)}
                >
                  ✕
                </button>
              </div>
              <div className="mono muted" style={{ fontSize: 10, marginBottom: 4 }}>
                {selectedEvent.observed_at.slice(11, 19)} · {selectedEvent.entity_id}
                {selectedEvent.trust_score_before != null &&
                selectedEvent.trust_score_after != null
                  ? ` · ${selectedEvent.trust_score_before}→${selectedEvent.trust_score_after}`
                  : ''}
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.4 }}>{selectedEvent.explanation}</div>
              {selectedEvent.check_ids.length > 0 && (
                <div className="muted mono" style={{ fontSize: 10, marginTop: 4 }}>
                  checks: {selectedEvent.check_ids.join(', ')}
                </div>
              )}
            </div>
          )}

          <div className="event-log">
            {events.length === 0 && (
              <div className="muted" style={{ padding: 12, fontSize: 12 }}>
                No events yet — run a scenario or wait for anomalies.
              </div>
            )}
            {events.map((e) => (
              <div
                key={e.id}
                className={`event-row ${e.severity}${selectedEventId === e.id ? ' selected' : ''}`}
                onClick={() =>
                  setSelectedEventId(selectedEventId === e.id ? null : e.id)
                }
              >
                <div className="event-row-main">
                  <span className={`event-dot ${e.severity}`} />
                  <span className="event-time mono">{e.observed_at.slice(11, 19)}</span>
                  <span className="event-vessel">{e.entity_id}</span>
                  <span className="event-title">{e.title}</span>
                  {e.trust_score_before != null && e.trust_score_after != null && (
                    <span className="event-delta mono">
                      {e.trust_score_before}→{e.trust_score_after}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'evidence' && (
        <div className="tab-body">
          {(vessel?.trust.checks ?? []).map((c) => (
            <div key={c.check_id} className="evidence-row">
              <div className="head">
                <strong className="mono">{c.check_id}</strong>
                <span className={`status-pill ${c.status}`}>{c.status}</span>
                {c.evidence_class && c.status !== 'unavailable' && c.status !== 'unsupported' && (
                  <span
                    className={`evidence-pill ${c.evidence_class}`}
                    title="Where this evidence comes from: live feed, recorded data, simulated/synthetic, or a fixed demo sample"
                  >
                    {c.evidence_class === 'simulated' && /synthetic/i.test(c.explanation)
                      ? 'synthetic'
                      : c.evidence_class}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.35 }}>{c.explanation}</div>
              <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                anomaly={c.anomaly_score ?? 'n/a'} · q={(c.quality ?? 0).toFixed(2)} · fresh=
                {(c.freshness ?? 0).toFixed(2)} · src={(c.source_ids ?? []).join(',') || '—'}
                {c.missing_reason ? ` · missing: ${c.missing_reason}` : ''}
                {c.hard_alert ? ' · HARD' : ''}
              </div>
            </div>
          ))}
          {!vessel && (
            <p className="muted" style={{ marginTop: 0 }}>
              Select a vessel to inspect evidence layers.
            </p>
          )}
        </div>
      )}

      {tab === 'sources' && (
        <div className="tab-body">
          {(() => {
            const fullstackId =
              snapshot?.lab?.fullstack_entity_id ?? snapshot?.lab?.signed_entity_id;
            const fullstackVessel = snapshot?.vessels?.find((v) => v.entity_id === fullstackId);
            const aoaStatus = snapshot?.lab?.rf_aoa_status;
            const cluster = snapshot?.lab?.rf_summary?.cluster_score;
            return (
              <div className={`live-card${fullstackId ? ' ok' : ''}`}>
                <div className="live-card-head">
                  <strong>Full-stack Lab vessel</strong>
                  <span className="origin-tag lab">RF+AoA</span>
                </div>
                <div className="source-detail">
                  Signed telemetry · OSNMA ICD · dual-antenna AoA
                </div>
                {fullstackId && fullstackVessel && (
                  <button
                    type="button"
                    className="live-row"
                    style={{ marginTop: 8, width: '100%' }}
                    onClick={() => useStore.getState().selectVessel(fullstackId)}
                  >
                    <span className="name">{fullstackVessel.name ?? fullstackId}</span>
                    <span className={`band ${fullstackVessel.trust.trust_band}`}>
                      {fullstackVessel.trust.trust_score}
                    </span>
                  </button>
                )}
                {aoaStatus && (
                  <div
                    className={`origin-tag ${aoaStatus === 'pass' ? 'live' : 'lab'}`}
                    style={{ marginTop: 8 }}
                  >
                    AoA: {aoaStatus}
                    {typeof cluster === 'number' ? ` · cluster ${cluster.toFixed(2)}` : ''}
                  </div>
                )}
              </div>
            );
          })()}

          <div
            className={`live-card${snapshot?.lab?.mode === 'historical_replay' ? ' ok' : ''}`}
            style={{ marginTop: 8 }}
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
            <div className="source-detail">Recorded Finnish AIS · attack overlays are synthetic</div>
            {snapshot?.lab?.osnma_protocol_status && (
              <div
                className={`origin-tag${snapshot.lab.osnma_protocol_status === 'authenticated' ? ' live' : ' lab'}`}
                style={{ marginTop: 8 }}
              >
                OSNMA:{' '}
                {snapshot.lab.osnma_protocol_status === 'authenticated'
                  ? 'ICD demo'
                  : snapshot.lab.osnma_protocol_status}
              </div>
            )}
            {snapshot?.lab?.recorder?.last_poll_at && (
              <div className="mono muted" style={{ fontSize: 10, marginTop: 6 }}>
                Recorder {snapshot.lab.recorder.status} · +{snapshot.lab.recorder.last_count} @{' '}
                {snapshot.lab.recorder.last_poll_at.slice(11, 19)}
              </div>
            )}
          </div>

          {(() => {
            const live = snapshot?.live;
            const liveOk =
              live?.digitraffic.status === 'ok' || live?.digitraffic.status === 'degraded';
            return (
              <div className={`live-card${liveOk ? ' ok' : ''}`} style={{ marginTop: 8 }}>
                <div className="live-card-head">
                  <strong>{liveOk ? 'Live AIS' : live?.digitraffic.status ?? 'Starting…'}</strong>
                  <span className="mono">{live?.vessel_count ?? 0} ships</span>
                </div>
                <div className="source-detail">
                  Digitraffic · partial coverage (kinematics / geo only)
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
              </div>
            );
          })()}
        </div>
      )}
    </aside>
  );
}
