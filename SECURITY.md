# Northstar — Security

## Cyber console (hackathon)

UI tab **Cyber** + APIs:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/security/threat-model` | Adversary → control mapping |
| `GET /api/security/summary` | Devices, forensics, audit, OSNMA |
| `GET /api/security/events` | Cryptographic forensics ring buffer |
| `POST /api/osnma/verify` | Run OSNMAlib on ICD `configuration_1` (or MAC-fail demo) |
| `POST /api/devices/:id/rotate` | Ed25519 key rotation |
| `POST /api/devices/:id/revoke` | Revoke device (signatures fail closed) |
| `GET /api/challenge/:deviceId` | Freshness challenge nonce |
| `GET /api/audit/verify` | Recompute SHA-256 hash chain |

## Threat model (hackathon scope)

| Threat | Mitigation |
|--------|------------|
| Tampered device telemetry | Ed25519 over RFC 8785 JCS canonical bytes + forensics |
| Replay of old valid messages | Seq + freshness + payload-hash LRU + optional challenge nonce |
| Spoofed public AIS | Never ground truth; cross-feed + kinematics + geo |
| Galileo nav-data forgery | OSNMAlib ICD vectors (TESLA delayed MAC + KROOT) |
| Audit rewriting | SHA-256 `prev_hash` chain + `/api/audit/verify` |
| Key compromise | Rotate / revoke APIs; assurance labelled **software** |
| Operator over-trust of score | UI disclaimer; score ≠ probability; coverage separate |
| Secrets in git | Keys in `./.northstar/keys` (gitignored); certs in `./certs` |

## Device identity

- Ed25519 via `@noble/ed25519`
- Enrollment / rotation / revocation in `DeviceRegistry`
- Assurance level default: **software** (see BLOCKERS B4)
- Private keys never committed

A valid signature proves the holder of the device key signed the payload and it was not modified after signing. It does **not** prove the sensor measurement is physically true.

## Transport

- Optional TLS (`NORTHSTAR_TLS_ENABLED`) and mTLS for device ingest
- `scripts/gen-certs.sh` creates a local demo CA
- TLS protects the connection; message signatures protect integrity across storage/forwarding
- Write endpoints rate-limited

## OSNMA

OSNMA authenticates supported Galileo **navigation-message data**, not receiver pseudoranges or the final PVT.

- Live SIS: **Not connected**
- Protocol path: **OSNMAlib** on official ICD test vectors (`vendor/OSNMA`, `npm run setup:osnma`)
- Results cached at `data/fixtures/osnma_icd_cache.json` after first successful verify

## Audit

Hash-chained JSONL at `data/fixtures/audit.jsonl` for enrollments, signature outcomes, replays, key ops, OSNMA, scenario changes.

## Production gaps (explicit)

- Software keys only; no secure boot / TPM binding
- Dashboard has no production IAM/authz
- Local demo CA only
- Map tiles third-party when online
