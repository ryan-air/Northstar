# Northstar — Implementation Plan

Status of phased delivery.

| Phase | Goal | Status |
|-------|------|--------|
| 0 | Repo scaffold, decisions, blockers | Complete |
| 1 | Contracts, adapters, geo, simulator | Complete |
| 2 | Core detection (kinematics, geo, neighbors) | Complete |
| 3 | Trust fusion + coverage + hard alerts | Complete |
| 4 | Cryptographic telemetry | Complete |
| 5 | API + ECDIS dashboard | Complete |
| 6 | Stretch integrations (honest boundaries) | Complete |
| 7 | Demo, eval, hardening, docs | Complete |

## Gates

- **P0:** Empty repo audited; stack chosen; DECISIONS/BLOCKERS written.
- **P1:** Zod contracts; Gulf of Finland geo; seeded simulator; validation.
- **P2:** Kinematics (CUSUM), geo, neighbors/cross-feed tested.
- **P3:** Fusion with correlation + hard alerts + coverage.
- **P4:** Ed25519 JCS sign/verify; replay guard; device registry; audit log; device-sim.
- **P5:** Fastify REST/WS; MapLibre console with scenario controls.
- **P6:** OSNMA sidecar boundary; GNSS/IMU simulated+unavailable; AISStream adapter disabled without key; software attestation provider.
- **P7:** Tests/build green; README + security/testing/demo docs; eval harness.
