/**
 * Live attacker terminal for demos — probes the three audit attacks.
 * Expect every attack to be REJECTED after the P0 fixes.
 *
 *   npx tsx scripts/attacker.ts [--api http://127.0.0.1:8080]
 */
const API = process.argv.includes('--api')
  ? process.argv[process.argv.indexOf('--api') + 1]!
  : 'http://127.0.0.1:8080';

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function main() {
  console.log(`Northstar attacker probes → ${API}\n`);

  const devices = (await (await fetch(`${API}/api/devices`)).json()) as Array<{
    device_id: string;
    entity_id: string;
    key_id: string;
    public_key: string;
  }>;
  const snap = (await (await fetch(`${API}/api/snapshot`)).json()) as {
    vessels: Array<{ entity_id: string; trust: { trust_score: number }; position: { lat: number; lon: number } }>;
  };
  const victim = snap.vessels[0];
  if (!victim) {
    console.error('No vessels — start the server first');
    process.exit(1);
  }
  const enrolled = devices[0];
  console.log(`Victim vessel: ${victim.entity_id} trust=${victim.trust.trust_score}`);
  console.log(`Enrolled device: ${enrolled?.device_id ?? '(none)'}\n`);

  // 1. Forged zero signature
  {
    const keyId = enrolled?.key_id ?? 'unknown-key';
    const deviceId = enrolled?.device_id ?? 'DEV-FAKE';
    const entityId = enrolled?.entity_id ?? victim.entity_id;
    const res = await fetch(`${API}/api/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: {
          v: 1,
          device_id: deviceId,
          entity_id: entityId,
          sequence_number: Date.now() % 1_000_000,
          timestamp: new Date().toISOString(),
          firmware_version: '1.0.0',
          position: { lat: 60.17, lon: 24.94, crs: 'EPSG:4326' },
          speed_over_ground_knots: 12,
          course_over_ground_deg: 90,
          challenge_nonce: 'forged-nonce',
        },
        signature: b64(new Uint8Array(64)),
        public_key_id: keyId,
        assurance_level: 'software',
        signature_alg: 'ed25519',
      }),
    });
    const body = await res.json();
    const after = (await (await fetch(`${API}/api/vessels/${encodeURIComponent(victim.entity_id)}`)).json()) as {
      position: { lat: number; lon: number };
      trust: { trust_score: number };
    };
    const trackUntouched =
      Math.abs(after.position.lat - victim.position.lat) < 1e-9 &&
      Math.abs(after.position.lon - victim.position.lon) < 1e-9;
    const pass = res.status >= 400 && trackUntouched;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} forged signature → HTTP ${res.status} reason=${body.reason ?? '?'} track_untouched=${trackUntouched}`,
    );
  }

  // 2. Binding mismatch (claim another vessel)
  {
    if (!enrolled) {
      console.log('SKIP binding mismatch — no enrolled device');
    } else {
      const other =
        snap.vessels.find((v) => v.entity_id !== enrolled.entity_id)?.entity_id ?? 'LAB-OTHER';
      const res = await fetch(`${API}/api/telemetry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: {
            v: 1,
            device_id: enrolled.device_id,
            entity_id: other,
            sequence_number: 1,
            timestamp: new Date().toISOString(),
            firmware_version: '1.0.0',
            position: { lat: 59.9, lon: 25.0, crs: 'EPSG:4326' },
            speed_over_ground_knots: 10,
            course_over_ground_deg: 90,
          },
          signature: b64(new Uint8Array(64)),
          public_key_id: enrolled.key_id,
          assurance_level: 'software',
        }),
      });
      const body = await res.json();
      const pass = res.status >= 400 && body.reason === 'binding_mismatch';
      console.log(
        `${pass ? 'PASS' : 'FAIL'} cross-entity binding → HTTP ${res.status} reason=${body.reason ?? '?'}`,
      );
    }
  }

  // 3. Unauthenticated challenge spam (should not return nonces without signature)
  {
    const deviceId = enrolled?.device_id ?? 'DEV-VESSEL-001';
    let leaked = 0;
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${API}/api/challenge/${deviceId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_id: deviceId,
          timestamp: new Date().toISOString(),
          signature: b64(new Uint8Array(64)),
        }),
      });
      if (res.ok) leaked += 1;
    }
    const pending = await fetch(`${API}/api/challenge/${deviceId}/pending`);
    const pass = leaked === 0 && pending.status === 404;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} challenge hardening → leaked=${leaked}/5 pending_status=${pending.status}`,
    );
  }

  console.log('\nDone. All PASS means the audit P0 attacks are closed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
