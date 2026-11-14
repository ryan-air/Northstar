import type { AttestationEvidence } from '@northstar/contracts';

export interface AttestationProvider {
  readonly name: string;
  readonly assuranceLevel: 'hardware' | 'software' | 'none';
  attest(deviceId: string): Promise<AttestationEvidence>;
}

/** Software-key attestation — honest assurance level, not hardware-backed. */
export class SoftwareAttestationProvider implements AttestationProvider {
  readonly name = 'software_key_store';
  readonly assuranceLevel = 'software' as const;

  async attest(deviceId: string): Promise<AttestationEvidence> {
    return {
      device_id: deviceId,
      assurance_level: 'software',
      provider: this.name,
      verified: true,
      observed_at: new Date().toISOString(),
      reason:
        'Software-protected local key file. Not TPM/secure-element/Secure-Enclave backed. macOS Secure Enclave is P-256-only and cannot hold Ed25519 device keys used here.',
    };
  }
}

/** Placeholder for future TPM / secure element / P-256 Secure Enclave attestation. */
export class HardwareAttestationProvider implements AttestationProvider {
  readonly name = 'hardware_unavailable';
  readonly assuranceLevel = 'none' as const;

  async attest(deviceId: string): Promise<AttestationEvidence> {
    return {
      device_id: deviceId,
      assurance_level: 'none',
      provider: this.name,
      verified: false,
      observed_at: new Date().toISOString(),
      reason: 'No TPM / secure element available in this environment (see BLOCKERS.md B4).',
    };
  }
}
