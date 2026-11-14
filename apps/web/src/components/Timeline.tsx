import { useStore } from '../lib/store';

export function Timeline() {
  const snapshot = useStore((s) => s.snapshot);
  const selectedEvent = useStore((s) => s.selectedEvent);
  const selectEvent = useStore((s) => s.selectEvent);
  const selectVessel = useStore((s) => s.selectVessel);
  const events = [...(snapshot?.timeline ?? [])].reverse();

  return (
    <footer className="bottom-strip">
      <div className="panel-title">Event timeline</div>
      <div className="timeline">
        {events.length === 0 && (
          <div className="muted" style={{ padding: 12 }}>
            No trust changes yet — run a scenario or wait for anomalies.
          </div>
        )}
        {events.map((e) => (
          <div
            key={e.id}
            className={`timeline-item ${e.severity} ${selectedEvent?.id === e.id ? 'selected' : ''}`}
            onClick={() => {
              selectEvent(e);
              selectVessel(e.entity_id);
            }}
          >
            <div className="t">{e.observed_at.slice(11, 19)} · {e.entity_id}</div>
            <div className="title">{e.title}</div>
            <div className="ex">{e.explanation}</div>
            {e.trust_score_before != null && e.trust_score_after != null && (
              <div className="mono muted" style={{ fontSize: 10, marginTop: 4 }}>
                {e.trust_score_before} → {e.trust_score_after}
                {e.hard ? ' · HARD' : ''}
              </div>
            )}
          </div>
        ))}
      </div>
      {selectedEvent && (
        <div className="explain" style={{ margin: '0 10px 6px' }}>
          <strong>{selectedEvent.title}</strong> — {selectedEvent.explanation}
          {selectedEvent.check_ids.length > 0 && (
            <span className="muted"> · checks: {selectedEvent.check_ids.join(', ')}</span>
          )}
        </div>
      )}
      <div className="disclaimer">
        Northstar estimates position integrity from cryptographic provenance, physical consistency,
        and independent observations. It is not a sole basis for navigation or collision avoidance.
        OSNMA (when shown) authenticates navigation data, not the PVT solution. AIS is not
        end-to-end authenticated.
      </div>
    </footer>
  );
}
