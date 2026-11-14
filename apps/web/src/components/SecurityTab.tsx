import { useEffect, useState } from 'react';

const adminToken = () =>
  (import.meta as { env?: { VITE_NORTHSTAR_ADMIN_TOKEN?: string } }).env?.VITE_NORTHSTAR_ADMIN_TOKEN ??
  'northstar-demo-admin';

interface AuditResult {
  ok: boolean;
  chain_ok?: boolean;
  checkpoint_ok?: boolean;
  entries?: number;
  broken_at?: number | null;
  reason?: string | null;
  tip_hash?: string;
}
interface Device {
  device_id: string;
  entity_id: string;
  key_id: string;
  signature_alg: string;
  assurance_level: string;
  enrolled_at: string;
  revoked_at: string | null;
}
interface SecEvent {
  id: string;
  ts: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  explanation?: string;
}
interface Summary {
  controls?: string[];
  revocation_count?: number;
  challenge_required?: boolean;
  last_telemetry_hash?: string | null;
}

const KIND_LABEL: Record<string, string> = {
  signature_verified: 'Signature verified',
  signature_failed: 'Signature rejected',
  replay_rejected: 'Replay rejected',
  challenge_issued: 'Challenge issued',
  challenge_failed: 'Challenge failed',
  ingest_rejected: 'AIS report rejected',
  enrolment_rejected: 'Enrolment rejected',
  admin_denied: 'Admin request denied',
  key_revoked: 'Key revoked',
  key_rotated: 'Key rotated',
  osnma_verified: 'OSNMA verified',
  osnma_failed: 'OSNMA failed',
};

const label = (k: string) => KIND_LABEL[k] ?? k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const hhmmss = (iso: string) => iso.slice(11, 19);

/**
 * Security tab: makes the platform's security controls visible and testable in four plain
 * sections — record integrity, device identity, freshness test, recent security events.
 */
export function SecurityTab() {
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [events, setEvents] = useState<SecEvent[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [fresh, setFresh] = useState<{ rejected: boolean; reason: string } | null>(null);
  const [verifiedCount, setVerifiedCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [d, e, s] = await Promise.all([
          fetch('/api/devices').then((r) => r.json()),
          fetch('/api/security/events?limit=200').then((r) => r.json()),
          fetch('/api/security/summary').then((r) => r.json()),
        ]);
        if (!alive) return;
        // The freshness test enrols a throwaway key each run; keep it out of the device list.
        setDevices((Array.isArray(d) ? d : []).filter((x: Device) => x.device_id !== 'DEV-CHALLENGE-MISS'));
        // Routine per-message events are summarised, so rejections and failures stand out.
        const all = (e?.events ?? []) as SecEvent[];
        setVerifiedCount(all.filter((x) => x.kind === 'signature_verified').length);
        setEvents(all.filter((x) => x.kind !== 'challenge_issued' && x.kind !== 'signature_verified').slice(0, 10));
        setSummary(s);
      } catch {
        /* server restarting */
      }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const verifyAudit = async () => {
    setAuditBusy(true);
    try {
      setAudit(await fetch('/api/audit/verify').then((r) => r.json()));
    } finally {
      setAuditBusy(false);
    }
  };

  const freshnessTest = async () => {
    const r = await fetch('/api/demo/challenge-miss', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken()}` },
    }).then((x) => x.json());
    const reason = String(r?.result?.reason ?? r?.error ?? 'unknown');
    setFresh({ rejected: r?.result?.ok === false, reason });
  };

  return (
    <div className="tab-body security-tab">
      <section className="sec-section">
        <h3>Record integrity</h3>
        <p className="sec-help">
          Every security-relevant event is appended to a SHA-256 hash chain whose tip is signed by the shore key.
          Editing or deleting any past entry breaks the chain.
        </p>
        <button type="button" className="sec-btn" onClick={() => void verifyAudit()} disabled={auditBusy}>
          {auditBusy ? 'Verifying…' : 'Verify audit chain'}
        </button>
        {audit && (
          <div className={`sec-result ${audit.ok ? 'ok' : 'bad'}`}>
            {audit.ok ? '✓ Chain and signed checkpoint intact' : `✗ Chain broken${audit.broken_at != null ? ` at entry ${audit.broken_at}` : ''}`}
            <span className="mono">
              {audit.entries ?? '—'} entries{audit.tip_hash ? ` · tip ${audit.tip_hash.slice(0, 16)}…` : ''}
            </span>
          </div>
        )}
      </section>

      <section className="sec-section">
        <h3>Device identity</h3>
        <p className="sec-help">
          Onboard telemetry is accepted only when signed by an enrolled key that is bound to that vessel and not
          revoked.
        </p>
        {devices.length === 0 && <div className="sec-empty">No enrolled devices.</div>}
        {devices.map((d) => (
          <div key={d.device_id} className="sec-kv">
            <div>
              <span className="k">Device</span>
              <span className="mono">{d.device_id}</span>
            </div>
            <div>
              <span className="k">Vessel</span>
              <span className="mono">{d.entity_id}</span>
            </div>
            <div>
              <span className="k">Key</span>
              <span className="mono">
                {d.signature_alg} · {d.key_id}
              </span>
            </div>
            <div>
              <span className="k">Status</span>
              <span className={d.revoked_at ? 'bad' : 'ok'}>{d.revoked_at ? 'revoked' : `active · ${d.assurance_level} key`}</span>
            </div>
          </div>
        ))}
        <div className="sec-note">
          Revoked keys on the shore-signed list: <span className="mono">{summary?.revocation_count ?? 0}</span>
        </div>
      </section>

      <section className="sec-section">
        <h3>Freshness test</h3>
        <p className="sec-help">
          Sends a correctly signed message that lacks the server's one-time challenge. A replayed or pre-recorded
          message looks like this, so it must be rejected.
        </p>
        <button type="button" className="sec-btn" onClick={() => void freshnessTest()}>
          Send without challenge
        </button>
        {fresh && (
          <div className={`sec-result ${fresh.rejected ? 'ok' : 'bad'}`}>
            {fresh.rejected ? '✓ Rejected as expected' : '✗ Accepted — challenge not enforced'}
            <span className="mono">{fresh.reason.replace(/_/g, ' ')}</span>
          </div>
        )}
      </section>

      <section className="sec-section">
        <h3>Recent security events</h3>
        <div className="sec-note">
          <span className="mono">{verifiedCount}</span> signed messages verified in the latest window; rejections and
          failures are listed below.
        </div>
        {events.length === 0 && <div className="sec-empty">No rejections or failures.</div>}
        {events.map((e) => (
          <div key={e.id} className={`sec-event ${e.severity}`}>
            <span className="mono when">{hhmmss(e.ts)}</span>
            <span className="what">{label(e.kind)}</span>
          </div>
        ))}
      </section>

      {summary?.controls && summary.controls.length > 0 && (
        <section className="sec-section">
          <h3>Controls in place</h3>
          <ul className="sec-controls">
            {summary.controls.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
