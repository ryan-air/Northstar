import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../lib/store';

interface SecurityEvent {
  id: string;
  ts: string;
  kind: string;
  severity: string;
  explanation: string;
  detail: Record<string, unknown>;
}

interface Summary {
  devices: Array<{
    device_id: string;
    entity_id: string;
    key_id: string;
    revoked: boolean;
    assurance_level: string;
    signature_alg?: string;
    public_key_prefix: string;
  }>;
  recent_events: SecurityEvent[];
  audit: {
    ok: boolean;
    chain_ok?: boolean;
    checkpoint_ok?: boolean | null;
    entries: number;
    tip: string;
    reason: string | null;
  };
  challenge_required?: boolean;
  role?: string;
  osnma: {
    sidecar: string;
    result: { status?: string; reason?: string | null; mode?: string } | null;
    lab_protocol?: string;
  };
  last_telemetry_hash?: {
    ok: boolean;
    hash: string;
    device_id?: string;
    reason?: string;
    at: string;
  } | null;
  controls: string[];
  fullstack_entity_id?: string | null;
  rf?: {
    aoa_status?: string;
    status?: string;
    antennas?: number;
    aoa?: { directions_deg?: number[]; cluster_score?: number; coherence?: number };
    spoof_overlay?: string | null;
    fc_note?: string | null;
    reason?: string | null;
  } | null;
}

interface ThreatModel {
  framing: string;
  adversaries: Array<{
    id: string;
    name: string;
    capability: string;
    northstar_controls: string[];
    residual_risk: string;
    demo?: { type: string; id: string };
  }>;
}

interface EvalMetrics {
  confusion?: { tp: number; fp: number; tn: number; fn: number };
  false_positive_rate?: number | null;
  false_negative_rate?: number | null;
  vessels_sampled?: number;
}

export function CyberPanel() {
  const runScenario = useStore((s) => s.runScenario);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [threats, setThreats] = useState<ThreatModel | null>(null);
  const [evalMetrics, setEvalMetrics] = useState<EvalMetrics | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string>('');

  const refresh = useCallback(async () => {
    const [s, t, e] = await Promise.all([
      fetch('/api/security/summary').then((r) => r.json()),
      fetch('/api/security/threat-model').then((r) => r.json()),
      fetch('/api/eval/metrics').then(async (r) => (r.ok ? r.json() : null)),
    ]);
    setSummary(s as Summary);
    setThreats(t as ThreatModel);
    setEvalMetrics(e as EvalMetrics | null);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 4000);
    return () => clearInterval(id);
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const out = await fn();
      setLog(`${label}: ${JSON.stringify(out).slice(0, 320)}`);
      await refresh();
    } catch (e) {
      setLog(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const deviceId =
    summary?.devices?.find((d) => !d.revoked)?.device_id ?? 'DEV-VESSEL-001';

  const exportBundle = async () => {
    const r = await fetch('/api/security/export');
    const data = await r.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `northstar-security-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setLog(`Exported forensics + audit (${(data.forensics ?? []).length} events)`);
  };

  return (
    <div className="tab-body cyber-panel">
      {evalMetrics?.confusion && (
        <div
          className="muted"
          style={{
            fontSize: 11,
            marginBottom: 10,
            lineHeight: 1.4,
            border: '1px solid var(--border, #333)',
            padding: 8,
          }}
        >
          <strong>Real-AIS eval</strong> ({evalMetrics.vessels_sampled ?? '?'} vessels) · TP=
          {evalMetrics.confusion.tp} FP={evalMetrics.confusion.fp} TN={evalMetrics.confusion.tn} FN=
          {evalMetrics.confusion.fn}
          {evalMetrics.false_positive_rate != null
            ? ` · FPR ${(evalMetrics.false_positive_rate * 100).toFixed(2)}%`
            : ''}
          {evalMetrics.false_negative_rate != null
            ? ` · FNR ${(evalMetrics.false_negative_rate * 100).toFixed(2)}%`
            : ''}
        </div>
      )}

      <div className="cyber-actions">
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            void run('OSNMA ICD verify', async () => {
              const adminToken =
                (import.meta as { env?: Record<string, string> }).env
                  ?.VITE_NORTHSTAR_ADMIN_TOKEN ?? 'northstar-demo-admin';
              const r = await fetch('/api/osnma/verify', {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({ scenario: 'configuration_1' }),
              });
              return r.json();
            })
          }
        >
          Verify OSNMA ICD
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            void run('OSNMA MAC fail', async () => {
              const adminToken =
                (import.meta as { env?: Record<string, string> }).env
                  ?.VITE_NORTHSTAR_ADMIN_TOKEN ?? 'northstar-demo-admin';
              const r = await fetch('/api/osnma/verify', {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({ scenario: 'failure' }),
              });
              return r.json();
            })
          }
        >
          OSNMA MAC fail
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void runScenario('signed_tamper')}
        >
          Tamper demo
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void runScenario('signed_replay')}
        >
          Replay demo
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            void run('Rotate key', async () => {
              const adminToken =
                (import.meta as { env?: { VITE_NORTHSTAR_ADMIN_TOKEN?: string } }).env
                  ?.VITE_NORTHSTAR_ADMIN_TOKEN ?? 'northstar-demo-admin';
              const r = await fetch(`/api/devices/${deviceId}/rotate`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({}),
              });
              return r.json();
            })
          }
        >
          Rotate key
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            void run('Revoke device', async () => {
              const adminToken =
                (import.meta as { env?: { VITE_NORTHSTAR_ADMIN_TOKEN?: string } }).env
                  ?.VITE_NORTHSTAR_ADMIN_TOKEN ?? 'northstar-demo-admin';
              const r = await fetch(`/api/devices/${deviceId}/revoke`, {
                method: 'POST',
                headers: { authorization: `Bearer ${adminToken}` },
              });
              return r.json();
            })
          }
        >
          Revoke
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            void run('Challenge', async () => {
              const r = await fetch(`/api/challenge/${deviceId}`);
              return r.json();
            })
          }
        >
          Issue challenge
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            void run('Send without challenge', async () => {
              const r = await fetch('/api/demo/challenge-miss', { method: 'POST' });
              return r.json();
            })
          }
        >
          Send without challenge
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            void run('Audit verify', async () => {
              const r = await fetch('/api/audit/verify');
              return r.json();
            })
          }
        >
          Verify audit
        </button>
        <button type="button" disabled={!!busy} onClick={() => void exportBundle()}>
          Export JSON
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            void run('RF AoA nominal', async () => {
              const r = await fetch('/api/rf/load', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ kind: 'nominal' }),
              });
              return r.json();
            })
          }
        >
          RF AoA nominal
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void runScenario('rf_aoa_spoof_cluster')}
        >
          RF AoA spoof cluster
        </button>
      </div>

      {busy && (
        <div className="muted mono" style={{ fontSize: 11 }}>
          Running {busy}…
        </div>
      )}
      {log && (
        <div className="mono cyber-log" style={{ fontSize: 10 }}>
          {log}
        </div>
      )}

      <div className="panel-title" style={{ marginTop: 10 }}>
        JCS payload hash
      </div>
      <div className="mono muted" style={{ fontSize: 10, wordBreak: 'break-all' }}>
        {summary?.last_telemetry_hash ? (
          <>
            {summary.last_telemetry_hash.ok ? 'OK' : 'FAIL'} ·{' '}
            {summary.last_telemetry_hash.hash}
            {summary.last_telemetry_hash.reason
              ? ` · ${summary.last_telemetry_hash.reason}`
              : ''}
          </>
        ) : (
          'Waiting for signed telemetry…'
        )}
      </div>

      <div className="panel-title">Controls</div>
      <ul className="cyber-list">
        {(summary?.controls ?? []).map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>

      <div className="panel-title">Devices</div>
      {(summary?.devices ?? []).map((d) => (
        <div key={d.device_id} className="cyber-device">
          <div>
            <strong className="mono">{d.device_id}</strong>
            <span className={`status-pill ${d.revoked ? 'fail' : 'pass'}`}>
              {d.revoked ? 'revoked' : d.assurance_level}
            </span>
          </div>
          <div className="muted mono" style={{ fontSize: 10 }}>
            {d.key_id} · {d.signature_alg ?? 'ed25519'} · pk {d.public_key_prefix}… · entity{' '}
            {d.entity_id}
            {d.assurance_level === 'hardware' ? ' · HARDWARE/PKCS#11' : ' · SOFTWARE'}
          </div>
        </div>
      ))}

      <div className="panel-title">OSNMA</div>
      <div className="muted" style={{ fontSize: 11, lineHeight: 1.35 }}>
        Sidecar: <span className="mono">{summary?.osnma.sidecar ?? '—'}</span>
        <br />
        ICD/result: <span className="mono">{summary?.osnma.result?.status ?? '—'}</span>
        {summary?.osnma.lab_protocol ? (
          <>
            <br />
            Hist Lab: <span className="mono">OSNMA {summary.osnma.lab_protocol}</span> (protocol
            demo — not live SIS)
          </>
        ) : null}
        <br />
        {summary?.osnma.result?.reason ?? null}
      </div>

      <div className="panel-title">RF lab / AoA</div>
      <div className="muted" style={{ fontSize: 11, lineHeight: 1.35 }}>
        Full-stack:{' '}
        <span className="mono">{summary?.fullstack_entity_id ?? '—'}</span>
        <br />
        AoA:{' '}
        <span className="mono">{summary?.rf?.aoa_status ?? summary?.rf?.status ?? '—'}</span>
        {summary?.rf?.antennas != null ? ` · ${summary.rf.antennas}-ant` : ''}
        {summary?.rf?.aoa?.cluster_score != null
          ? ` · cluster ${summary.rf.aoa.cluster_score.toFixed(2)}`
          : ''}
        {summary?.rf?.aoa?.directions_deg?.length
          ? ` · DoA ${summary.rf.aoa.directions_deg.map((d) => d.toFixed(1)).join(', ')}°`
          : ''}
        <br />
        {summary?.rf?.spoof_overlay
          ? `Overlay: ${summary.rf.spoof_overlay}`
          : summary?.rf?.reason ?? null}
        {summary?.rf?.fc_note ? (
          <>
            <br />
            {summary.rf.fc_note}
          </>
        ) : null}
      </div>

      <div className="panel-title">Audit chain</div>
      <div className={`origin-tag ${summary?.audit.ok ? 'live' : 'lab'}`}>
        {summary?.audit.ok ? 'INTACT' : 'BROKEN'} · {summary?.audit.entries ?? 0} entries
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        CHAIN:{' '}
        <span className="mono">
          {summary?.audit.chain_ok === false
            ? 'BROKEN'
            : summary?.audit.chain_ok === true
              ? 'OK'
              : summary?.audit.ok
                ? 'OK'
                : 'BROKEN'}
        </span>
        {' · '}
        CHECKPOINT:{' '}
        <span className="mono">
          {summary?.audit.checkpoint_ok === false
            ? 'BROKEN'
            : summary?.audit.checkpoint_ok === true
              ? 'OK'
              : 'n/a'}
        </span>
        {summary?.challenge_required != null
          ? ` · challenge ${summary.challenge_required ? 'required' : 'optional'}`
          : ''}
        {summary?.role ? ` · role ${summary.role}` : ''}
        <br />
        {summary?.audit.tip}
        {summary?.audit.reason ? ` — ${summary.audit.reason}` : ''}
      </div>

      <div className="panel-title">Forensics</div>
      <div className="cyber-events">
        {(summary?.recent_events ?? []).map((e) => (
          <div key={e.id} className={`cyber-event ${e.severity}`}>
            <div className="mono" style={{ fontSize: 10 }}>
              {e.ts.slice(11, 19)} · {e.kind}
            </div>
            <div style={{ fontSize: 11 }}>{e.explanation}</div>
          </div>
        ))}
      </div>

      <div className="panel-title">Threat model</div>
      {(threats?.adversaries ?? []).map((a) => (
        <div key={a.id} className="threat-card">
          <strong>{a.name}</strong>
          <div className="muted" style={{ fontSize: 11, lineHeight: 1.35 }}>
            {a.capability}
          </div>
          <div style={{ fontSize: 11, marginTop: 4 }}>
            Controls: {(a.northstar_controls ?? []).join('; ')}
          </div>
          <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
            Residual: {a.residual_risk}
          </div>
          {a.demo?.type === 'scenario' && (
            <button
              type="button"
              style={{ marginTop: 6, fontSize: 11 }}
              onClick={() => void runScenario(a.demo!.id as Parameters<typeof runScenario>[0])}
            >
              Run demo: {a.demo.id}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
