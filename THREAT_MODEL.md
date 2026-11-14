# Northstar threat model

Northstar estimates **integrity** of maritime position reports. It is not a certified navigation or collision-avoidance system. Trust scores are heuristic estimates, not calibrated probabilities.

## Adversaries

| Adversary | Goal | Primary controls |
|-----------|------|------------------|
| AIS / GNSS spoofer | Displace vessels on the shore picture | Kinematics, geographic, fleet coherence, signed-vs-AIS |
| Telemetry forger | Inject positions without a device key | Signature verify; rejected data never updates tracks |
| Compromised gateway | Impersonate other vessels | Device↔entity↔key binding |
| Local browser / LAN abuse | Call admin APIs | Admin bearer token, CORS allowlist |
| Revocation / audit tamper | Revive keys or rewrite history | Shore-signed CRL + head; audit hash chain fail-closed |

## What signing proves

Ed25519 / P-256 signatures prove **provenance and integrity of device telemetry bytes** from an enrolled device. They do **not** prove that the physical GNSS fix is true.

The device-sim now signs an **independent onboard track** (replay MMSI + noisy GNSS), not the server's AIS position. The shore compares signed onboard data against AIS (`signed_vs_ais`). Spoofing AIS while the device stays honest shows up as disagreement.

## Detection layers (honest scope)

- **From data:** kinematics (incl. post-gap reachability), geographic, neighbors, fleet coherence, signed-vs-AIS, device signature.
- **Lab / demo:** OSNMA ICD test-vector verification (real OSNMAlib, not live SIS for a vessel), dual-antenna lab IQ / AoA (feature retained; centre frequency is reported in evidence).
- **Unavailable by design:** AIS-B cross-feed (no independent second AIS source), attestation for vessels without a device, GNSS/IMU scenario-swapped fixtures.

## Known limitations

- RF AoA uses a lab dual-antenna capture; centre frequency is shown in the UI. Per-satellite GNSS correlation is out of scope for this demo build.
- OSNMA authenticates the Galileo ICD test vector / TESLA chain in the sidecar — not a live vessel PVT.
- Fusion uses max-of-strong-evidence / noisy-OR so passes cannot dilute a decisive failure.
- Admin demo token defaults to `northstar-demo-admin` when `NORTHSTAR_ADMIN_TOKEN` is unset (local demo only).

## Demo probes

```bash
npx tsx scripts/attacker.ts
```

Adversarial unit coverage: `apps/server/src/attacks.test.ts`.
