import { useStore } from '../lib/store';
import type { ScenarioId } from '../lib/types';

interface Scenario {
  id: ScenarioId;
  label: string;
  hint: string;
}

// Navigation / physical-consistency attacks.
const NAV_SCENARIOS: Scenario[] = [
  { id: 'normal', label: 'Normal', hint: 'Stop any injected attack (simulated ships recover; nothing else changes)' },
  { id: 'sudden_spoof', label: 'Sudden spoof', hint: 'Jump inland' },
  { id: 'gradual_drift', label: 'Gradual drift', hint: 'Slow divergence' },
  { id: 'ais_disagreement', label: 'AIS conflict', hint: 'Independent feed conflict' },
  { id: 'gnss_jamming', label: 'GNSS jam', hint: 'Simulated signal degradation' },
  { id: 'imu_disagreement', label: 'IMU disagree', hint: 'Simulated inertial residual' },
];

// Cryptographic / RF security tests.
const SEC_SCENARIOS: Scenario[] = [
  { id: 'signed_tamper', label: 'Sig tamper', hint: 'Alter field after sign' },
  { id: 'signed_replay', label: 'Sig replay', hint: 'Old sequence resent' },
  { id: 'stale_clock_skew', label: 'Clock skew', hint: 'Provider B timestamps aged' },
  { id: 'osnma_auth', label: 'OSNMA auth', hint: 'ICD test vector — authenticated' },
  { id: 'osnma_failure', label: 'OSNMA fail', hint: 'ICD test vector — failed' },
  { id: 'rf_aoa_spoof_cluster', label: 'RF AoA spoof', hint: 'Synthetic spoof overlay on real 2-ant IQ' },
];

interface Props {
  onCyberOpen: () => void;
}

export function BottomBar({ onCyberOpen }: Props) {
  const runScenario = useStore((s) => s.runScenario);
  const activeScenario = useStore((s) => s.snapshot?.active_scenario);
  const last = useStore((s) => s.lastScenario);

  const renderGroup = (label: string, scenarios: Scenario[]) => (
    <div className="scenario-group">
      <span className="scenario-group-label">{label}</span>
      <div className="scenario-buttons">
        {scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`scenario-btn${activeScenario === s.id ? ' active' : ''}`}
            title={s.hint}
            onClick={() => void runScenario(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="bottom-bar">
      <button type="button" className="cyber-trigger" onClick={onCyberOpen}>
        🛡 Cyber Console ↑
      </button>
      <div className="bottom-divider" />
      {renderGroup('Navigation', NAV_SCENARIOS)}
      {renderGroup('Security', SEC_SCENARIOS)}
      {last?.target && (
        <div
          className="scenario-notice"
          title="Attacks are only injected into simulated ships — never into recorded or live vessels."
        >
          {last.scenario.replace(/_/g, ' ')} → {last.target} (simulated)
          {last.retargeted_from ? ` · redirected from ${last.retargeted_from}` : ''}
        </div>
      )}
    </div>
  );
}
