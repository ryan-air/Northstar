/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) — deterministic serialization
 * for Ed25519 signatures. Only JSON-compatible values; no undefined.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export function canonicalize(value: JsonValue): string {
  return serialize(value);
}

function serialize(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('JCS cannot serialize non-finite numbers');
    }
    // ECMAScript number to JSON already matches JCS for finite numbers
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${serialize(value[k] as JsonValue)}`)
    .join(',');
  return `{${body}}`;
}

export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
