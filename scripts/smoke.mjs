/**
 * API smoke check — start the server first (`npm run dev -w @northstar/server`).
 */
const base = process.env.NORTHSTAR_URL ?? 'http://127.0.0.1:8080';

async function main() {
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  if (!health.ok) throw new Error('health failed');
  const snap = await fetch(`${base}/api/snapshot`).then((r) => r.json());
  if (snap.monitoring_label !== 'SIMULATION' && snap.data_mode !== 'simulation') {
    console.warn('Unexpected mode', snap.monitoring_label);
  }
  if (!Array.isArray(snap.vessels)) throw new Error('no vessels array');
  const spoof = await fetch(`${base}/api/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario: 'sudden_spoof', entity_id: 'VESSEL-001' }),
  }).then((r) => r.json());
  if (!spoof.ok) throw new Error('scenario failed');
  await fetch(`${base}/api/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario: 'reset' }),
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        vessels: snap.vessels.length,
        metrics: snap.metrics,
        scenario_set: spoof.snapshot?.active_scenario,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
