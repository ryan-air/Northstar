import type { CheckResult, GnssDiagnostics } from '@northstar/contracts';

export interface GnssDiagConfig {
  min_satellites: number;
  min_c_n0_dbhz: number;
  max_hdop: number;
  jamming_agc_delta: number;
}

export function checkGnssDiagnostics(
  entityId: string,
  diag: GnssDiagnostics | null,
  config: GnssDiagConfig,
  nowIso: string,
): CheckResult {
  if (!diag) {
    return {
      entity_id: entityId,
      check_id: 'gnss_diagnostics',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation:
        'Raw GNSS receiver diagnostics unavailable. Missing inputs: C/N0, satellite count, pseudorange residuals, AGC.',
      source_ids: [],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason:
        'No raw receiver measurements (UBX-RXM-RAWX / RINEX / equivalent) connected',
      evidence: { missing_inputs: ['c_n0', 'satellites', 'residuals', 'agc'] },
      hard_alert: false,
    };
  }

  const simulated = diag.labels?.simulated === true;
  const findings: string[] = [];
  let anomaly = 0;
  const evidence: Record<string, unknown> = {
    satellite_count: diag.satellite_count,
    hdop: diag.hdop,
    agc: diag.agc,
    interference: diag.interference_indicator,
    simulated,
  };

  if (diag.satellite_count != null && diag.satellite_count < config.min_satellites) {
    anomaly = Math.max(anomaly, 0.7);
    findings.push(`Low satellite count (${diag.satellite_count}).`);
  }
  if (diag.hdop != null && diag.hdop > config.max_hdop) {
    anomaly = Math.max(anomaly, 0.65);
    findings.push(`Poor geometry HDOP=${diag.hdop}.`);
  }
  if (diag.c_n0_dbhz && diag.c_n0_dbhz.length > 0) {
    const mean = diag.c_n0_dbhz.reduce((a, b) => a + b, 0) / diag.c_n0_dbhz.length;
    evidence.mean_c_n0 = mean;
    if (mean < config.min_c_n0_dbhz) {
      anomaly = Math.max(anomaly, 0.75);
      findings.push(`Low mean C/N0 ${mean.toFixed(1)} dB-Hz.`);
    }
  }

  if (diag.interference_indicator === 'suspected_jamming') {
    anomaly = Math.max(anomaly, 0.85);
    findings.push(
      'Receiver indicators consistent with jamming/interference (degraded reception), not necessarily spoofing.',
    );
  } else if (diag.interference_indicator === 'suspected_spoofing') {
    anomaly = Math.max(anomaly, 0.9);
    findings.push(
      'Correlated abrupt measurement changes consistent with suspected spoofing (plausible but anomalous residuals).',
    );
  }

  const status = anomaly >= 0.85 ? 'fail' : anomaly >= 0.4 ? 'warning' : 'pass';
  const prefix = simulated ? '[Simulated fixture] ' : '';
  return {
    entity_id: entityId,
    check_id: 'gnss_diagnostics',
    status,
    anomaly_score: anomaly,
    severity: status === 'fail' ? 'high' : status === 'warning' ? 'medium' : 'none',
    observed_at: nowIso,
    explanation:
      prefix +
      (findings.length
        ? findings.join(' ')
        : 'Receiver diagnostics within nominal thresholds.'),
    source_ids: [simulated ? 'gnss_fixture_simulated' : 'gnss_receiver'],
    quality: simulated ? 0.5 : 0.9,
    freshness: 1,
    reliability: simulated ? 0.4 : 0.85,
    missing_reason: null,
    evidence,
    hard_alert: false,
  };
}
