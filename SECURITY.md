# Northstar — Security

Northstar's job is to judge whether navigation data can be trusted, so its own inputs, records and controls have to be trustworthy too. This document lists the controls that are actually implemented, how to see them, and what is still out of scope. See [THREAT_MODEL.md](THREAT_MODEL.md) for the adversary-by-adversary view.

## Seeing the controls

The dashboard's **Security** tab (right panel) shows them live:

| Section | What it does |
|---|---|
| Record integrity | Recomputes the SHA-256 audit hash chain and checks the shore-signed checkpoint (`GET /api/audit/verify`) |
| Device identity | Enrolled devices, the vessel each is bound to, key algorithm, status, revoked-key count |
| Freshness test | Sends a correctly signed message without the one-time challenge; it must be rejected (`POST /api/demo/challenge-miss`) |
| Recent security events | Rejections and failures from the forensics log (`GET /api/security/events`); routine verifications summarised |
| Controls in place | Live list from `GET /api/security/summary` |

## Controls

### Signed onboard telemetry
- Ed25519 (software) or ECDSA P-256 (PKCS#11 / YubiKey) over RFC 8785 canonical JSON.
- Each device is bound to one vessel and one key; the envelope's algorithm must match the enrolment.
- A valid signature proves who signed the data and that it was not modified. It does **not** prove the measured position is physically true; that is what the independent-evidence checks are for.
- Forged, tampered or unbound telemetry never updates a vessel; it is logged to forensics only.

### Replay and freshness
- Monotonic per-device sequence numbers, timestamp freshness and a payload-hash cache.
- One-time server challenge nonces (required by default); a message without a valid challenge is rejected.
- The device keeps its sequence counter across restarts, as a real device would.

### Enrolment and keys
- Enrolment needs an admin token or an enrolment token. **One-time, per-vessel, expiring enrolment tokens** (`POST /api/devices/enrol-tokens`) are stored only as hashes. The shared enrolment token works only on a loopback bind.
- One active device per vessel unless an admin explicitly replaces it.
- Key rotation and revocation, with a shore-signed revocation list. Revocation is not exposed in the dashboard, so a live demo cannot be broken by accident.
- Private keys are generated locally under `.northstar/` (gitignored) and never leave the device side.

### Access control
- **Scoped admin tokens** (`NORTHSTAR_ADMIN_TOKENS`): scenario, rf, osnma, audit, devices, demo. Wrong scope → 403, unknown token → 401, both logged.
- Constant-time token comparison; only SHA-256 digests are kept in memory.
- Without `NORTHSTAR_ADMIN_TOKEN` the demo token works **only on a loopback bind**; on any network address the server refuses to start.
- Optional dashboard WebSocket token (`NORTHSTAR_WS_TOKEN`); CORS allowlist; rate limits on write and telemetry routes.

### Transport
- TLS / mutual-TLS device server (`NORTHSTAR_TLS_ENABLED`, `NORTHSTAR_MTLS_ENABLED`, local CA via `scripts/gen-certs.sh`).
- Plain-HTTP telemetry is **refused on non-loopback binds**.

### Tamper-evident records
- Every security-relevant event (enrolments, signature outcomes, replays, key operations, scenario changes, Lab jumps/resets) is appended to a SHA-256 `prev_hash` chain with a shore-signed tip checkpoint. Any edit or deletion breaks verification and the log fails closed.

### Input validation
- All AIS is validated before use: schema, AIS "not available" sentinels, stale and future timestamps, duplicates and out-of-order reports.
- Seeded fuzzing of every untrusted-input boundary runs in CI (`npm run fuzz`): AIS ingest, signed-telemetry verification (a tampered envelope never verifies), canonical JSON, the AIS adapters, the lab loaders and map simplification. It found and fixed a type-confusion bug on untrusted AISStream fields.
- CI also runs `npm audit` and publishes a CycloneDX SBOM (`npm run sbom`).

### Honest evidence
- Every check carries an evidence class: `live`, `recorded`, `simulated` or synthetic. **Verified coverage** counts only live and recorded evidence.
- Attacks are injected **only into simulated ships**; recorded and live vessels never receive injected data. There is no override.
- Synthetic inputs (the lab vessel's attestation chain and OSNMA results) are verified where possible (the attestation chain and enrolment signature are checked cryptographically) but always labelled synthetic.

## Data handling

- Lab vessel sensor data was **received from a lab at UIUC after we reached out on Friday**. It is private: kept in local, gitignored folders, never committed, and not redistributed.
- Recorded AIS used for evaluation is also kept out of the repository; data files were removed from the public git history.
- The repository runs without any private data (simulated fleet + live AIS).
- The real-time AIS client identifies itself only with a generic client name.

## Out of scope / known gaps

- Software device keys by default; hardware attestation for the lab vessel is synthetic.
- Galileo OSNMA: real OSNMAlib on official ICD test vectors; the lab vessel's OSNMA inputs are synthetic; no live signal-in-space receiver.
- No production identity provider; admin access is token-based.
- Public AIS is not authenticated; Northstar treats it as a claim to be checked, never as ground truth.
- Strong independent evidence exists only for the instrumented lab vessel; other ships rely on AIS-based checks.
