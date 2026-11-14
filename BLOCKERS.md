# Northstar — Blockers

External dependencies that prevent a *genuine* live integration. Adapters and honest UI states are implemented regardless.

| ID | Dependency | Impact | Current mitigation | Needed from user |
|----|------------|--------|--------------------|------------------|
| B1 | No GNSS receiver with raw measurements | Live signal diagnostics unavailable | Adapter + Simulated fixture; status `Unavailable` with missing inputs listed | Compatible receiver (e.g. u-blox F9/X20) or recorded UBX/RINEX |
| B2 | No OSNMA-capable receiver or live I/NAV stream | Live OSNMA unavailable | OSNMAlib sidecar on recorded/test vectors labelled "Protocol verification demo"; live `Not connected`; default scope = fullstack Hist Lab only | Receiver or authenticated live recording |
| B3 | No physical IMU | Live IMU consistency unavailable | Simulated IMU with uncertainty growth; live `Unavailable` | IMU/INS stream or phone sensor bridge |
| B4 | No TPM / secure element by default; Secure Enclave is P-256 not Ed25519 | Hardware-backed attestation optional | Software-key default; **PKCS#11 SoftHSM / YubiKey P-256 path** (`scripts/setup-softhsm.sh`, `HARDWARE_KEYS.md`); SoftHSM ≠ silicon | YubiKey 5 or TPM for stronger residual |
| B5 | ~~No live AIS~~ | Mitigated | **Digitraffic** live AIS (no key) for Finnish waters; AISStream optional via `AISSTREAM_API_KEY` | Broader global AIS still needs AISStream/other key |
| B6 | Map tile / OpenSeaMap may be unreachable (offline / restricted network) | Online nautical map unavailable | UI auto-falls back to bundled GeoJSON land/coast/ports and shows offline banner. `npm run check-tiles` probes reachability. | Optional `MAP_STYLE_URL` or accept offline |

## Status legend for UI

- `Unavailable` — adapter present, no live input
- `Unsupported` — capability not applicable (e.g. non-Galileo constellation)
- `Simulated` / `Protocol verification demo` — fixture or offline verification, never claimed as live
- `Not connected` — live path not wired or not authenticated
- `hardware` (PKCS#11) — SoftHSM or YubiKey; SoftHSM residual is host-readable token DB
