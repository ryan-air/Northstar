import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeviceEnrollment } from '@northstar/contracts';
import { b64ToBytes, bytesToB64, generateKeyPair } from '@northstar/core';
import { REPO_ROOT } from '../config.js';

export class DeviceRegistry {
  private devices = new Map<string, DeviceEnrollment>();
  private byKeyId = new Map<string, DeviceEnrollment>();
  private path: string;

  /**
   * @param pathOrRel Absolute path, or path relative to REPO_ROOT (default fixtures).
   */
  constructor(pathOrRel = 'data/fixtures/devices.json') {
    this.path = pathOrRel.startsWith('/') ? pathOrRel : join(REPO_ROOT, pathOrRel);
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      const list = JSON.parse(readFileSync(this.path, 'utf8')) as DeviceEnrollment[];
      for (const d of list) this.index(d);
    }
  }

  private index(d: DeviceEnrollment): void {
    this.devices.set(d.device_id, d);
    this.byKeyId.set(d.key_id, d);
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify([...this.devices.values()], null, 2));
  }

  get(deviceId: string): DeviceEnrollment | undefined {
    return this.devices.get(deviceId);
  }

  /** Active (non-revoked) devices bound to an entity. */
  activeForEntity(entityId: string): DeviceEnrollment[] {
    return [...this.devices.values()].filter((d) => d.entity_id === entityId && !d.revoked_at);
  }

  getByKeyId(keyId: string): DeviceEnrollment | undefined {
    return this.byKeyId.get(keyId);
  }

  getPublicKey(deviceId: string): Uint8Array | null {
    const d = this.devices.get(deviceId);
    if (!d || d.revoked_at) return null;
    return b64ToBytes(d.public_key);
  }

  async enroll(input: {
    device_id: string;
    entity_id: string;
    public_key_b64?: string;
    firmware_version?: string;
    assurance_level?: 'software' | 'hardware' | 'none';
    signature_alg?: 'ed25519' | 'ecdsa-p256';
  }): Promise<{ enrollment: DeviceEnrollment; privateKeyB64?: string }> {
    let public_key = input.public_key_b64;
    let privateKeyB64: string | undefined;
    const signature_alg = input.signature_alg ?? 'ed25519';
    if (!public_key) {
      if (signature_alg !== 'ed25519') {
        throw new Error('Auto-enroll only supports ed25519; supply public_key_b64 for ecdsa-p256');
      }
      const kp = await generateKeyPair();
      public_key = bytesToB64(kp.publicKey);
      privateKeyB64 = bytesToB64(kp.privateKey);
    }
    const enrollment: DeviceEnrollment = {
      device_id: input.device_id,
      entity_id: input.entity_id,
      public_key,
      key_id: `${input.device_id}-key-1`,
      enrolled_at: new Date().toISOString(),
      revoked_at: null,
      assurance_level: input.assurance_level ?? 'software',
      signature_alg,
      firmware_version: input.firmware_version ?? '1.0.0',
    };
    this.index(enrollment);
    this.persist();
    return { enrollment, privateKeyB64 };
  }

  /** Rebind an enrolled device to a different entity without rotating keys. */
  bindEntity(deviceId: string, entityId: string): DeviceEnrollment | null {
    const prev = this.devices.get(deviceId);
    if (!prev) return null;
    const enrollment: DeviceEnrollment = { ...prev, entity_id: entityId };
    this.index(enrollment);
    this.persist();
    return enrollment;
  }

  async rotate(
    deviceId: string,
    newPublicKeyB64?: string,
  ): Promise<{ enrollment: DeviceEnrollment; privateKeyB64?: string }> {
    const prev = this.devices.get(deviceId);
    if (!prev) throw new Error('unknown device');
    let public_key = newPublicKeyB64;
    let privateKeyB64: string | undefined;
    if (!public_key) {
      const kp = await generateKeyPair();
      public_key = bytesToB64(kp.publicKey);
      privateKeyB64 = bytesToB64(kp.privateKey);
    }
    // Drop old key_id index
    this.byKeyId.delete(prev.key_id);
    const enrollment: DeviceEnrollment = {
      ...prev,
      public_key,
      key_id: `${deviceId}-key-${Date.now()}`,
      enrolled_at: new Date().toISOString(),
      revoked_at: null,
    };
    this.index(enrollment);
    this.persist();
    return { enrollment, privateKeyB64 };
  }

  revoke(deviceId: string): DeviceEnrollment | null {
    const d = this.devices.get(deviceId);
    if (!d) return null;
    d.revoked_at = new Date().toISOString();
    this.persist();
    return d;
  }

  list(): DeviceEnrollment[] {
    return [...this.devices.values()];
  }
}
