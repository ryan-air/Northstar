/** Static threat model for hackathon judges — maps attacks → Northstar controls. */

export const THREAT_MODEL = {
  product: 'Northstar',
  framing:
    'Shore/ops integrity + cryptographic provenance layer. Not a certified navigation system.',
  assets: [
    'Vessel position integrity estimate (trust score + evidence)',
    'Signed onboard telemetry channel (Ed25519)',
    'Hash-chained audit log',
    'OSNMA navigation-message authentication evidence (ICD test vectors)',
  ],
  adversaries: [
    {
      id: 'ais_spoof',
      name: 'AIS / position spoofing',
      capability: 'Inject false lat/lon into public AIS or forged NMEA',
      northstar_controls: [
        'kinematics jump/drift detection',
        'geographic land/restricted conflict',
        'dual-feed AIS disagreement',
        'signed device telemetry (if gateway present)',
      ],
      residual_risk: 'Spoof with consistent kinematics + RF-plausible GNSS still hard without receiver residuals',
      demo: { type: 'scenario', id: 'sudden_spoof' },
    },
    {
      id: 'telemetry_tamper',
      name: 'Tampered signed telemetry',
      capability: 'Modify position after signing, or forge unsigned messages',
      northstar_controls: [
        'JCS canonicalization + Ed25519 verify',
        'reject on signature failure',
        'forensics event + audit entry',
      ],
      residual_risk: 'Compromised private key until rotation/revocation',
      demo: { type: 'scenario', id: 'signed_tamper' },
    },
    {
      id: 'replay',
      name: 'Replay / delay attack',
      capability: 'Resend a previously valid signed envelope',
      northstar_controls: [
        'sequence monotonicity',
        'payload hash duplicate cache',
        'freshness window / clock skew checks',
        'required challenge-nonce (default)',
      ],
      residual_risk: 'Wide freshness window allows delayed-but-fresh replays if challenge not outstanding',
      demo: { type: 'api', id: 'POST /api/demo/challenge-miss' },
    },
    {
      id: 'key_theft',
      name: 'Device key compromise',
      capability: 'Steal software key file from gateway host',
      northstar_controls: [
        'software vs PKCS#11 hardware assurance labelling',
        'key rotation + revoke APIs',
        'shore-signed revocation list (CRL-lite)',
        'optional SoftHSM / YubiKey PIV path (HARDWARE_KEYS.md)',
      ],
      residual_risk:
        'Default path is software keys; SoftHSM DB is host-readable — use YubiKey for stronger residual',
      demo: { type: 'api', id: 'POST /api/devices/:id/revoke' },
    },
    {
      id: 'osnma_nav',
      name: 'Galileo nav-data forgery',
      capability: 'Forge I/NAV content without valid OSNMA tags',
      northstar_controls: [
        'OSNMAlib ICD vector verification (TESLA delayed MAC + KROOT)',
        'Evidence layer fails closed on MAC mismatch test',
      ],
      residual_risk:
        'OSNMA ≠ PVT auth; authenticated nav data can still feed a spoofed receiver solution',
      demo: { type: 'api', id: 'POST /api/osnma/verify' },
    },
    {
      id: 'audit_tamper',
      name: 'Audit log rewriting',
      capability: 'Edit or drop security events after the fact',
      northstar_controls: [
        'SHA-256 hash chain with prev_hash linking',
        'shore-signed tip checkpoint (+ optional mirror path)',
        'GET /api/audit/verify',
      ],
      residual_risk:
        'Adversary who rewrites JSONL and forges/overwrites checkpoint + shore private key (+ mirror)',
      demo: { type: 'api', id: 'GET /api/audit/verify' },
    },
  ],
  demos: [
    { scenario: 'sudden_spoof', maps_to: 'ais_spoof' },
    { scenario: 'signed_tamper', maps_to: 'telemetry_tamper' },
    { scenario: 'signed_replay', maps_to: 'replay' },
    { scenario: 'osnma_failure', maps_to: 'osnma_nav' },
    { action: 'POST /api/devices/:id/rotate', maps_to: 'key_theft' },
    { action: 'POST /api/devices/:id/revoke', maps_to: 'key_theft' },
    { action: 'GET /api/audit/verify', maps_to: 'audit_tamper' },
    { action: 'GET /api/security/export', maps_to: 'audit_tamper' },
  ],
} as const;
