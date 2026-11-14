# Northstar — Security design (hackathon)

## One-line claim

Public AIS/position streams are **unauthenticated**. Northstar adds **passwordless device identity** (Ed25519 or PKCS#11 P-256) and **explainable integrity** so shore systems can trust *who said what* and detect tamper, replay, and spoof-like inconsistencies.

## Assets

1. Signed onboard telemetry channel (device private key — software file or PKCS#11)
2. Trust / evidence assessment for monitored vessels
3. Hash-chained audit log + **shore-signed tip checkpoint**
4. Shore-signed **revocation list** (CRL-lite)
5. OSNMA protocol-demo evidence (ICD vectors via OSNMAlib) on **fullstack Hist Lab vessel only** (default)
6. Dual-antenna lab IQ / AoA on one full-stack Hist Lab vessel (Manavi capture)
7. Optional **mTLS** device plane (channel identity ≠ payload provenance)

## Adversaries → controls

| Adversary | Control | Demo |
|-----------|---------|------|
| AIS / position spoof | Kinematics, geo, dual AIS, signed gateway | Scenario `sudden_spoof` |
| Tampered signed message | JCS + Ed25519 / ECDSA-P256 verify | Scenario `signed_tamper` |
| Replay | Seq + hash cache + freshness + **required** challenge | Scenario `signed_replay` / Cyber → Send without challenge |
| Key theft | Rotate / revoke + revocation list; PKCS#11 path | Cyber → Revoke; see `HARDWARE_KEYS.md` |
| Nav-data forgery | OSNMAlib ICD TESLA/MAC + KROOT (fullstack only) | Cyber → Verify OSNMA ICD |
| Audit rewrite | SHA-256 `prev_hash` + shore checkpoint | Cyber → Verify audit |

Full machine-readable model: `GET /api/security/threat-model`.

## Roles

- **`NORTHSTAR_ROLE=shore`** (default): verify-only for devices; shore Ed25519 under `.northstar/shore/` signs checkpoints + revocation. Device private keys belong to **device-sim** (`.northstar/keys` or PKCS#11).
- Shore refuses device `*.ed25519` private keys placed in the shore key directory.

## Residual risk (say out loud)

- **OSNMA ≠ PVT authentication** — nav-message auth does not prove the fix.
- **Default keys are software** — SoftHSM upgrades the PKCS#11 *path* but its DB is still host-readable; YubiKey PIV is stronger (see `HARDWARE_KEYS.md`).
- **LIVE Digitraffic AIS** has no I/NAV → OSNMA stays unavailable on `LIVE-*` (honest).
- Hist Lab OSNMA ICD demo binds to the **fullstack** vessel by default (`NORTHSTAR_OSNMA_SCOPE=fullstack`).
- AoA binds only to the **full-stack** Hist Lab vessel; LIVE AIS never gets fake RF.
- Spoof-cluster AoA demo may use a **labeled synthetic single-direction overlay** on real IQ when the capture has no spoof timestamps.
- Checkpoint+mirror defeated only if attacker also controls shore private key (and mirror).

## Export for judges

`GET /api/security/export` — forensics, audit tail, checkpoint verify, devices, revocation list, OSNMA result, threat model.
