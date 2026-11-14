/**
 * Lab case study: replay the trial vessel's own AIS through the v2 pipeline twice —
 * (a) AIS only, (b) AIS + lab evidence — and report, per receiver-flagged interference
 * event, which checks fired and how fast. Reads the private lab folder (data_lab/ or
 * NORTHSTAR_LAB_DIR); writes results only to the gitignored runtime dir.
 *
 *   npx tsx scripts/lab/case-study.ts [--out .northstar/lab_case_study.json]
 *
 * Event windows come from the receiver's own UBX-SEC-SIG flags, not from lab labels.
 * U2 (attestation) and U5 (OSNMA) are synthetic: reported, but listed separately.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { TrustAssessment } from '@northstar/contracts';
import { atOrBefore, labFolderPath, loadLabFolder } from '../../apps/server/src/lab/labFolder.js';
import { ROOT, makeEngine, recordToEvent, recordTime } from '../eval/lib.js';

const argOut = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : '.northstar/lab_case_study.json';
const OUT = isAbsolute(argOut) ? argOut : join(ROOT, argOut);

const SYNTHETIC = new Set(['osnma', 'attestation']);
const flagged = (t: TrustAssessment | undefined) => t?.trust_band === 'suspicious' || t?.trust_band === 'critical';
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);

interface Row {
  t: number;
  lat: number;
  lon: number;
  band: string;
  score: number;
  failing: string[];
  warning: string[];
  verified_coverage: number | undefined;
}

/** Measurement only: smooth, kinematically consistent offset ramped in over rampS seconds. */
interface Offset {
  startMs: number;
  endMs: number;
  metres: number;
  bearingDeg: number;
  rampS: number;
  /** true: GNSS spoof of the vessel (its broadcast, so the secondary AIS too); false: one feed tampered. */
  vessel: boolean;
}

function applyOffset(lat: number, lon: number, t: number, o: Offset | null): [number, number] {
  if (!o || t < o.startMs || t > o.endMs) return [lat, lon];
  const f = Math.min(1, (t - o.startMs) / (o.rampS * 1000));
  const d = o.metres * f;
  const b = (o.bearingDeg * Math.PI) / 180;
  return [lat + (d * Math.cos(b)) / 111_320, lon + (d * Math.sin(b)) / (111_320 * Math.cos((lat * Math.PI) / 180))];
}

function run(withLab: boolean, offset: Offset | null = null) {
  const lab = loadLabFolder(labFolderPath(ROOT));
  if (!lab) throw new Error('lab folder not found (data_lab/ or NORTHSTAR_LAB_DIR)');
  const engine = makeEngine({ label: 'v2', fusion: 'v2', thresholds: 'v2', validate: true });
  const p = engine.pipeline;
  const id = lab.entityId;
  if (withLab) {
    p.setDrSeries(id, lab.dr);
    p.setTargetObservations(id, lab.targetObs);
    if (lab.attestation) p.setAttestation(id, lab.attestation);
  }
  const rows: Row[] = [];
  let secIdx = 0;
  for (const r of lab.primaryAis) {
    const t = recordTime(r);
    const [olat, olon] = applyOffset(r.lat, r.lon, t, offset);
    const ev = { ...recordToEvent({ ...r, lat: olat, lon: olon }, {}), entity_id: id };
    if (withLab) {
      const g = atOrBefore(lab.gnss, (x) => Date.parse(x.observed_at), t, 2000);
      if (g) p.setGnss(g);
      const o = atOrBefore(lab.osnma, (x) => Date.parse(x.observed_at), t, 2000);
      p.setOsnma(id, o);
      const cap = lab.captures.find((c) => t >= c.startMs - 60_000 && t <= c.endMs + 60_000);
      p.setRfLab(id, cap ? cap.result : null);
      while (secIdx < lab.secondaryAis.length && Date.parse(lab.secondaryAis[secIdx]!.source_timestamp) <= t) {
        const s2 = lab.secondaryAis[secIdx]!;
        if (offset?.vessel) {
          const [la, lo] = applyOffset(s2.position.lat, s2.position.lon, Date.parse(s2.source_timestamp), offset);
          p.ingestSecondary({ ...s2, position: { ...s2.position, lat: la, lon: lo } });
        } else p.ingestSecondary(s2);
        secIdx++;
      }
    }
    if (engine.validator) {
      const v = engine.validator.validate(ev, new Date(t));
      if (!v.ok) continue;
    }
    const s = p.process(ev, new Date(t).toISOString());
    rows.push({
      t,
      lat: r.lat,
      lon: r.lon,
      band: s.trust.trust_band,
      score: s.trust.trust_score,
      failing: s.trust.checks.filter((c) => c.status === 'fail').map((c) => c.check_id),
      warning: s.trust.checks.filter((c) => c.status === 'warning').map((c) => c.check_id),
      verified_coverage: s.trust.verified_evidence_coverage,
    });
  }
  return { lab, rows };
}

function main(): void {
  const a = run(false);
  const b = run(true);
  const lab = b.lab;
  const events = lab.receiverEvents;
  const inEvent = (t: number, pad = 0) => events.some((e) => t >= e.startMs - pad && t <= e.endMs + pad);

  const perEvent = events.map((e) => {
    const sel = (rows: Row[]) => rows.filter((r) => r.t >= e.startMs && r.t <= e.endMs + 120_000);
    const summarise = (rows: Row[]) => {
      const first = rows.find((r) => flagged({ trust_band: r.band } as TrustAssessment));
      const checks = new Map<string, number>();
      for (const r of rows) for (const c of [...r.failing, ...r.warning]) checks.set(c, (checks.get(c) ?? 0) + 1);
      return {
        reports: rows.length,
        flagged_reports: rows.filter((r) => r.band === 'suspicious' || r.band === 'critical').length,
        first_flag: first ? hhmmss(first.t) : null,
        time_to_detect_s: first ? Math.round((first.t - e.startMs) / 1000) : null,
        checks_fired: Object.fromEntries([...checks].sort((x, y) => y[1] - x[1])),
      };
    };
    return {
      kind: e.kind,
      receiver_state_max: e.maxState,
      window: `${hhmmss(e.startMs)}–${hhmmss(e.endMs)}`,
      ais_only: summarise(sel(a.rows)),
      with_lab: summarise(sel(b.rows)),
    };
  });

  const outside = (rows: Row[]) => {
    const o = rows.filter((r) => !inEvent(r.t, 120_000));
    return { reports: o.length, flagged: o.filter((r) => r.band === 'suspicious' || r.band === 'critical').length };
  };

  const checkNonSynthetic = (rows: Row[]) =>
    rows.filter((r) => inEvent(r.t)).map((r) => ({
      t: hhmmss(r.t),
      band: r.band,
      recorded_evidence_fails: r.failing.filter((c) => !SYNTHETIC.has(c)),
      synthetic_evidence_fails: r.failing.filter((c) => SYNTHETIC.has(c)),
    }));

  // Counterfactual (measurement only, copy of the recorded AIS): a smooth fake track the
  // AIS-only checks cannot see, during voyage V2 outside every receiver-flagged event.
  // Pick the 60-minute mid-voyage window (after the first 30 min) with the most reports and no
  // receiver-flagged event within 10 minutes — chosen from the data, not hard-coded.
  const cfWin = (() => {
    let best: [number, number] | null = null;
    let bestN = -1;
    for (const r of b.rows) {
      const s = r.t;
      const e = s + 3_600_000;
      if (s < lab.windowMs[0] + 1_800_000 || e > lab.windowMs[1]) continue;
      if (events.some((ev) => ev.endMs >= s - 600_000 && ev.startMs <= e + 600_000)) continue;
      // Mid-voyage only (underway ≥ 10 kn throughout): the hard case, not a harbour manoeuvre.
      const inWin = lab.primaryAis.filter((x) => recordTime(x) >= s && recordTime(x) <= e);
      if (inWin.some((x) => (x.sog ?? 0) < 10)) continue;
      const n = b.rows.filter((x) => x.t >= s && x.t <= e).length;
      if (n > bestN) {
        bestN = n;
        best = [s, e];
      }
    }
    return best;
  })();
  const counterfactual = !cfWin ? [] : [
    { metres: 1000, vessel: true },
    { metres: 3000, vessel: true },
    { metres: 1000, vessel: false },
  ].map(({ metres, vessel }) => {
    const o: Offset = {
      vessel,
      startMs: cfWin[0],
      endMs: cfWin[1],
      metres,
      bearingDeg: 90,
      rampS: 600,
    };
    const score = (rows: Row[]) => {
      const att = rows.filter((r) => r.t >= o.startMs + o.rampS * 1000 && r.t <= o.endMs);
      const first = rows.find((r) => r.t >= o.startMs && r.t <= o.endMs && (r.band === 'suspicious' || r.band === 'critical'));
      return {
        reports_at_full_offset: att.length,
        flagged: att.filter((r) => r.band === 'suspicious' || r.band === 'critical').length,
        first_flag_after_start_s: first ? Math.round((first.t - o.startMs) / 1000) : null,
        checks: [...new Set(att.flatMap((r) => r.failing))],
        warning_checks: [...new Set(att.flatMap((r) => r.warning))],
      };
    };
    return {
      model: vessel ? 'GNSS spoof of the vessel (primary + secondary AIS shifted)' : 'one AIS feed tampered (primary only)',
      offset_m: metres,
      ramp_s: o.rampS,
      window: `${hhmmss(cfWin[0])}–${hhmmss(cfWin[1])} (underway ≥10 kn, no receiver flags within 10 min)`,
      ais_only: score(run(false, o).rows),
      with_lab: score(run(true, o).rows),
    };
  });

  const result = {
    counterfactual_consistent_fake_track: counterfactual,
    vessel: { entity_id: lab.entityId, name: lab.name, reports: lab.primaryAis.length },
    window: `${new Date(lab.windowMs[0]).toISOString()} – ${new Date(lab.windowMs[1]).toISOString()}`,
    evidence_inputs: {
      recorded: {
        gnss_seconds: lab.gnss.length,
        dr_seconds: lab.dr.length,
        radar_sar_observations: lab.targetObs.length,
        secondary_ais_rows: lab.secondaryAis.length,
        rf_captures: lab.captures.map((c) => ({ id: c.id, status: c.result.status, R: c.result.aoa?.cluster_score })),
      },
      synthetic: {
        osnma_seconds: lab.osnma.length,
        attestation_verified_to_synthetic_root: lab.attestation?.verified ?? false,
      },
    },
    events: perEvent,
    false_alarms_outside_events: { ais_only: outside(a.rows), with_lab: outside(b.rows) },
    reports_in_events_with_lab: checkNonSynthetic(b.rows),
    notes: [
      'Event windows are the receiver’s own SEC-SIG jamming/spoofing flags (state ≥ 2), not lab labels.',
      'One vessel, one 7-hour window: a case study, not a statistical evaluation.',
      'osnma and attestation evidence is synthetic (U5, U2).',
      ...lab.notes,
    ],
    rows_with_lab: b.rows.map((r) => ({ ...r, t: new Date(r.t).toISOString() })),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');

  console.log(`Lab case study — ${lab.name} (${lab.entityId}), ${lab.primaryAis.length} AIS reports`);
  for (const e of perEvent) {
    console.log(`\n${e.kind} ${e.window} (receiver state ${e.receiver_state_max})`);
    for (const [k, v] of [['AIS only ', e.ais_only], ['with lab ', e.with_lab]] as const) {
      console.log(`  ${k}: ${v.flagged_reports}/${v.reports} reports flagged, first ${v.first_flag ?? '—'} (TTD ${v.time_to_detect_s ?? '—'} s), checks ${JSON.stringify(v.checks_fired)}`);
    }
  }
  console.log('\nCounterfactual consistent fake track (measurement only, injected into a copy):');
  for (const c of counterfactual) {
    console.log(`  [${c.model}] ${c.offset_m} m: AIS only ${c.ais_only.flagged}/${c.ais_only.reports_at_full_offset} flagged; with lab ${c.with_lab.flagged}/${c.with_lab.reports_at_full_offset} (first ${c.with_lab.first_flag_after_start_s ?? '—'} s after start; failing: ${c.with_lab.checks.join(', ') || 'none'}; warning: ${c.with_lab.warning_checks.join(', ') || 'none'})`);
  }
  const fa = result.false_alarms_outside_events;
  console.log(`\nOutside events: AIS only ${fa.ais_only.flagged}/${fa.ais_only.reports} flagged; with lab ${fa.with_lab.flagged}/${fa.with_lab.reports} flagged`);
  console.log(`\nwrote ${OUT}`);
}

main();
