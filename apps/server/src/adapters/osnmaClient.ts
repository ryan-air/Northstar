import type { OsnmaResult } from '@northstar/contracts';

export class OsnmaSidecarClient {
  status: 'unavailable' | 'ok' | 'down' | 'pending' = 'unavailable';
  last: OsnmaResult | null = null;
  lastError: string | null = null;

  constructor(private baseUrl: string) {}

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      this.status = res.ok ? 'ok' : 'down';
      return res.ok;
    } catch (e) {
      this.status = 'down';
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async result(): Promise<OsnmaResult | null> {
    try {
      const res = await fetch(`${this.baseUrl}/result`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as OsnmaResult & { crypto?: unknown };
      this.last = body;
      this.status = 'ok';
      this.lastError = null;
      return body;
    } catch (e) {
      this.status = 'down';
      this.lastError = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async verify(scenario: 'configuration_1' | 'failure' = 'configuration_1', force = false) {
    const q = new URLSearchParams({ scenario, force: force ? '1' : '0' });
    const res = await fetch(`${this.baseUrl}/verify?${q}`);
    if (!res.ok) throw new Error(`OSNMA verify HTTP ${res.status}`);
    const body = (await res.json()) as OsnmaResult;
    this.last = body;
    this.status = 'ok';
    return body;
  }
}
