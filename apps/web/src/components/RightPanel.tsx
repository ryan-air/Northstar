import { useState } from 'react';
import { useStore } from '../lib/store';
import type { ScenarioId } from '../lib/types';
import { CyberPanel } from './CyberPanel';

const SCENARIOS: Array<{ id: ScenarioId; label: string; hint: string }> = [
  { id: 'normal', label: 'Normal navigation', hint: 'Healthy track, high trust' },
  { id: 'sudden_spoof', label: 'Sudden spoof / teleport', hint: 'Jump inland' },
  { id: 'gradual_drift', label: 'Gradual drift spoofing', hint: 'Slow divergence' },
  { id: 'ais_disagreement', label: 'AIS neighbor disagreement', hint: 'Independent feed conflict' },
  { id: 'gnss_jamming', label: 'GNSS jamming-like', hint: 'Simulated signal degradation' },
  { id: 'imu_disagreement', label: 'IMU disagreement', hint: 'Simulated inertial residual' },
  { id: 'signed_tamper', label: 'Signed telemetry tamper', hint: 'Alter field after sign' },
  { id: 'signed_replay', label: 'Replayed signed message', hint: 'Old sequence resent' },
  { id: 'stale_clock_skew', label: 'Stale / clock skew', hint: 'Provider B timestamps aged' },
  {
    id: 'osnma_auth',
    label: 'OSNMA auth (test vector)',
    hint: 'Protocol verification demo — authenticated',
  },
  {
    id: 'osnma_failure',
    label: 'OSNMA MAC failure (fixture)',
    hint: 'Protocol verification demo — failed',
  },
  {
    id: 'rf_aoa_spoof_cluster',
    label: 'RF AoA single-direction',
    hint: 'Synthetic spoof overlay on real 2-ant IQ',
  },
  { id: 'reset', label: 'Reset scenario', hint: 'Clear state & restart' },
];

export function RightPanel() {
  const [tab, setTab] = useState<'vessel' | 'evidence' | 'scenarios' | 'cyber'>('cyber');
  const snapshot = useStore((s) => s.snapshot);
  const selectedId = useStore((s) => s.selectedId);
  const selectVessel = useStore((s) => s.selectVessel);
  const runScenario = useStore((s) => s.runScenario);
  const vessel = snapshot?.vessels?.find((v) => v.entity_id === selectedId);

  return (
    <aside className="panel right">
      <div className="tabs">
        <button className={tab === 'vessel' ? 'active' : ''} onClick={() => setTab('vessel')}>
          Vessel
        </button>
        <button className={tab === 'evidence' ? 'active' : ''} onClick={() => setTab('evidence')}>
          Evidence
        </button>
        <button className={tab === 'cyber' ? 'active' : ''} onClick={() => setTab('cyber')}>
          Cyber
        </button>
        <button
          className={tab === 'scenarios' ? 'active' : ''}
          onClick={() => setTab('scenarios')}
        >
          Scenarios
        </button>
      </div>

      {tab === 'vessel' && (
        <div className="tab-body">
          <div className="panel-title" style={{ padding: '0 0 8px', border: 'none' }}>
            Fleet
          </div>
          <div style={{ maxHeight: 120, overflow: 'auto', marginBottom: 10 }}>
            {(snapshot?.vessels ?? []).map((v) => {
              const isFull =
                v.entity_id === snapshot?.lab?.fullstack_entity_id ||
                v.entity_id === snapshot?.lab?.signed_entity_id;
              return (
                <button
                  key={v.entity_id}
                  onClick={() => selectVessel(v.entity_id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: v.entity_id === selectedId ? 'var(--bg-elevated)' : 'transparent',
                    border: '1px solid var(--border-soft)',
                    marginBottom: 4,
                    padding: '6px 8px',
                  }}
                >
                  <span className="mono">
                    {v.name ?? v.entity_id}
                    {isFull ? ' · FULL-STACK' : v.origin === 'live' ? ' · LIVE' : ''}
                  </span>
                  <span style={{ float: 'right', color: 'var(--text-dim)' }}>
                    {v.trust.trust_score}
                  </span>
                </button>
              );
            })}
          </div>

          {vessel ? (
            <>
              <div className="kv">
                <div className="k">ID</div>
                <div className="v">{vessel.entity_id}</div>
                <div className="k">Name</div>
                <div className="v">{vessel.name ?? '—'}</div>
                <div className="k">Class</div>
                <div className="v">{vessel.vessel_class ?? '—'}</div>
                <div className="k">Trust</div>
                <div className="v">
                  {vessel.trust.trust_score} ({vessel.trust.trust_band})
                </div>
                <div className="k">Coverage</div>
                <div className="v">
                  {vessel.trust.evidence_coverage.toFixed(0)}% · {vessel.trust.available_checks}/
                  {vessel.trust.expected_checks}
                </div>
                <div className="k">Position</div>
                <div className="v">
                  {vessel.position.lat.toFixed(5)} N, {vessel.position.lon.toFixed(5)} E
                </div>
                <div className="k">Updated</div>
                <div className="v">{vessel.last_update}</div>
              </div>
              <div className="explain">{vessel.trust.explanation}</div>
            </>
          ) : (
            <p className="muted">No vessel selected.</p>
          )}
        </div>
      )}

      {tab === 'evidence' && (
        <div className="tab-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 11, lineHeight: 1.35 }}>
            Full-stack Lab vessel includes dual-ant lab AoA. LIVE ships stay RF-unavailable. Look
            for Simulated / Protocol demo / Lab IQ labels — never treat those as Digitraffic RF.
          </p>
          {(vessel?.trust.checks ?? []).map((c) => {
            const ev = (c.evidence ?? {}) as Record<string, unknown>;
            const scenarioInjected =
              !!ev.spoof_overlay ||
              ev.fixture === true ||
              (ev.labels as { fixture?: boolean; simulated?: boolean } | undefined)?.fixture ===
                true ||
              /spoof_overlay|scenario|fixture|Simulated|Protocol verification demo/i.test(
                c.explanation,
              );
            const dataBadge =
              c.status === 'unavailable' || c.status === 'unsupported'
                ? null
                : scenarioInjected
                  ? 'scenario-injected'
                  : 'detected from data';
            const mode =
              c.check_id === 'rf_lab' || c.check_id === 'spatial_aoa'
                ? c.status === 'unavailable'
                  ? 'No lab RF'
                  : 'Lab IQ / AoA'
                : (c.source_ids ?? []).some((s) => /simulat|fixture|demo/i.test(s)) ||
                    /\[Simulated|Protocol verification demo/i.test(c.explanation)
                  ? c.check_id === 'osnma'
                    ? 'Protocol demo'
                    : 'Simulated'
                  : c.status === 'unavailable' || c.status === 'unsupported'
                    ? 'No live input'
                    : 'Live path';
            const fcHz = typeof ev.center_freq_hz === 'number' ? ev.center_freq_hz : null;
            return (
              <div key={c.check_id} className="evidence-row">
                <div className="head">
                  <strong className="mono">{c.check_id}</strong>
                  <span className={`status-pill ${c.status}`}>{c.status}</span>
                </div>
                <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>
                  mode: {mode}
                  {dataBadge ? (
                    <>
                      {' · '}
                      <span
                        style={{
                          color:
                            dataBadge === 'detected from data'
                              ? 'var(--ok, #6c6)'
                              : 'var(--warn, #cc8)',
                        }}
                      >
                        {dataBadge}
                      </span>
                    </>
                  ) : null}
                  {fcHz != null ? ` · fc ${(fcHz / 1e6).toFixed(3)} MHz` : ''}
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.35 }}>{c.explanation}</div>
                <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                  anomaly={c.anomaly_score ?? 'n/a'} · q={(c.quality ?? 0).toFixed(2)} · fresh=
                  {(c.freshness ?? 0).toFixed(2)} · src={(c.source_ids ?? []).join(',') || '—'}
                  {c.missing_reason ? ` · missing: ${c.missing_reason}` : ''}
                  {c.hard_alert ? ' · HARD' : ''}
                </div>
              </div>
            );
          })}
          {!vessel && <p className="muted">Select a vessel to inspect evidence layers.</p>}
        </div>
      )}

      {tab === 'cyber' && <CyberPanel />}

      {tab === 'scenarios' && (
        <div className="tab-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
            Attack overlays on Digitraffic historical AIS replay (or synthetic fallback). Overlays
            are labelled — base tracks are recorded Finnish AIS when Hist Lab is active.
          </p>
          <div className="scenario-list">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                className={`${snapshot?.active_scenario === s.id ? 'active' : ''} ${s.id === 'reset' ? 'reset' : ''}`}
                onClick={() => runScenario(s.id)}
              >
                <div>{s.label}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {s.hint}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
