import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  RfLabResultSchema,
  ScenarioCommandSchema,
  SignedTelemetryEnvelopeSchema,
} from '@northstar/contracts';
import { b64ToBytes, canonicalBytes, type JsonValue } from '@northstar/core';
import * as ed from '@noble/ed25519';
import { NorthstarApp } from './app.js';
import { REPO_ROOT } from './config.js';
import { authorizeAdmin, isLoopbackHost, parseScopedTokens, plaintextTelemetryAllowed, resolveAdminToken, wsTokenOk, type AdminScope } from './security/adminAuth.js';
import { labReturnSummary, listLabReturns, loadLabReturn } from './lab/labReturn.js';

async function main() {
  const app = new NorthstarApp();
  await app.init();

  // Web UI always on cleartext HTTP (httpPort). Optional separate HTTPS+mTLS for devices.
  const server = Fastify({
    logger: true,
  });

  const corsOrigins = new Set([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    ...(process.env.NORTHSTAR_CORS_ORIGIN ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]);
  await server.register(cors, {
    origin: (origin, cb) => cb(null, !origin || corsOrigins.has(origin)),
  });
  await server.register(rateLimit, {
    // Dev/demo: device-sim + WS poll + UI burst easily; keep telemetry tighter below
    max: 2000,
    timeWindow: '1 minute',
  });
  await server.register(websocket);

  const testMode = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
  const adminCfg = resolveAdminToken({
    envToken: process.env.NORTHSTAR_ADMIN_TOKEN,
    testMode,
    host: app.env.host,
    allowDemo: process.env.NORTHSTAR_ALLOW_DEMO_ADMIN === 'true',
  });
  const adminToken = adminCfg.token;
  if (adminCfg.warning) server.log.warn(adminCfg.warning);
  const wsToken = process.env.NORTHSTAR_WS_TOKEN?.trim() || null;
  if (!wsToken && !isLoopbackHost(app.env.host)) {
    server.log.warn(`NORTHSTAR_WS_TOKEN is unset; /ws on ${app.env.host} is readable by anyone who can reach it`);
  }
  // Scoped admin credentials (NORTHSTAR_ADMIN_TOKENS); the single admin token keeps '*'.
  const principals = parseScopedTokens(process.env.NORTHSTAR_ADMIN_TOKENS);
  if (principals.length) server.log.info(`scoped admin principals: ${principals.map((p) => `${p.name}[${[...p.scopes].join('+')}]`).join(', ')}`);
  const requireScope =
    (scope: AdminScope) =>
    async (
      req: { headers: { authorization?: string } },
      reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    ) => {
      const d = authorizeAdmin(req.headers.authorization, scope, adminToken, principals);
      if (!d.ok) {
        app.forensics.push('admin_denied', `Admin request denied (${d.error}) for scope ${scope}`, { scope, error: d.error }, 'warning');
        return reply.code(d.status).send({ error: d.error, scope });
      }
    };
  const allowPlaintextDevice = plaintextTelemetryAllowed(
    app.env.host,
    process.env.NORTHSTAR_ALLOW_PLAINTEXT_DEVICE === 'true',
  );
  if (!allowPlaintextDevice) {
    server.log.warn(`plain-HTTP /api/telemetry disabled on ${app.env.host}: devices must use the TLS device server (NORTHSTAR_TLS_ENABLED)`);
  }

  const telemetryByDevice = new Map<string, number[]>();
  const checkDeviceRate = (deviceId: string): boolean => {
    const cutoff = Date.now() - 60_000;
    const recent = (telemetryByDevice.get(deviceId) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= 30) {
      telemetryByDevice.set(deviceId, recent);
      return false;
    }
    recent.push(Date.now());
    telemetryByDevice.set(deviceId, recent);
    return true;
  };

  const issueSignedChallenge = async (
    deviceId: string,
    body: unknown,
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const request = body as { device_id?: string; timestamp?: string; signature?: string };
    if (
      request?.device_id !== deviceId ||
      typeof request.timestamp !== 'string' ||
      typeof request.signature !== 'string'
    ) {
      return reply.code(400).send({ error: 'invalid_challenge_request' });
    }
    const timestampMs = Date.parse(request.timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 30_000) {
      return reply.code(401).send({ error: 'challenge_request_timestamp_rejected' });
    }
    const enrollment = app.registry.get(deviceId);
    if (!enrollment || enrollment.revoked_at || enrollment.signature_alg === 'ecdsa-p256') {
      return reply.code(401).send({ error: 'device_not_enrolled_for_ed25519' });
    }
    try {
      const message = canonicalBytes({
        device_id: request.device_id,
        timestamp: request.timestamp,
      } as JsonValue);
      const valid = await ed.verifyAsync(
        b64ToBytes(request.signature),
        message,
        b64ToBytes(enrollment.public_key),
      );
      if (!valid) return reply.code(401).send({ error: 'invalid_challenge_signature' });
    } catch {
      return reply.code(401).send({ error: 'invalid_challenge_signature' });
    }
    return app.forensics.issueChallenge(deviceId);
  };

  server.get('/api/health', async () => ({
    ok: true,
    product: 'Northstar',
    mode: app.env.dataMode,
    disclaimer:
      'Not a certified navigation, safety, or collision-avoidance system. Trust scores are heuristic integrity estimates, not probabilities.',
  }));

  server.get('/api/snapshot', async () => app.snapshot());

  server.get('/api/vessels', async () => app.pipeline.getVessels());
  server.get<{ Params: { id: string } }>('/api/vessels/:id', async (req, reply) => {
    const v = app.pipeline.getVessels().find((x) => x.entity_id === req.params.id);
    if (!v) return reply.code(404).send({ error: 'not_found' });
    return v;
  });

  server.get('/api/alerts', async () => app.pipeline.getAlerts());
  server.get('/api/timeline', async () => app.pipeline.getTimeline());
  server.get('/api/metrics', async () => app.metrics());
  server.get('/api/eval/metrics', async (_req, reply) => {
    const path = join(REPO_ROOT, 'data/fixtures/eval_metrics.json');
    if (!existsSync(path)) {
      return reply.code(404).send({
        error: 'not_found',
        hint: 'Run: npx tsx scripts/eval-real-ais.ts',
      });
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  });
  server.get('/api/feed-health', async () => app.feedHealth());
  server.get('/api/devices', async () => app.registry.list());
  server.get('/api/osnma', async () => ({
    live: 'not_connected',
    sidecar: {
      url: app.env.osnmaUrl,
      status: app.osnmaClient.status,
      last_error: app.osnmaClient.lastError,
    },
    demo: app.getOsnmaDemoStatus(),
    note: 'OSNMA authenticates supported Galileo navigation-message data, not the PVT solution.',
  }));

  server.get('/api/rf', async () => ({
    fullstack_entity_id: app.fullstackEntityId(),
    result: app.getRfLabResult(),
    note: 'Dual-antenna lab IQ / AoA binds only to the full-stack Hist Lab vessel — never LIVE AIS.',
  }));

  server.post('/api/rf/result', { preHandler: requireScope('rf') }, async (req, reply) => {
    const parsed = RfLabResultSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_rf_result', detail: parsed.error.message });
    }
    const applied = app.applyRfLabResult(parsed.data);
    return { ok: true, ...applied };
  });

  server.post('/api/rf/load', { preHandler: requireScope('rf') }, async (req) => {
    const kind = (req.body as { kind?: string })?.kind === 'spoof' ? 'spoof' : 'nominal';
    const applied = app.loadRfLabResult(kind);
    return { ok: true, kind, ...applied, result: app.getRfLabResult(), snapshot: app.snapshot() };
  });

  // P4.2: state-changing — admin only.
  server.post('/api/osnma/verify', { preHandler: requireScope('osnma') }, async (req, reply) => {
    const body = (req.body ?? {}) as { scenario?: string };
    const scenario =
      body.scenario === 'failure' || body.scenario === 'failed'
        ? 'failure'
        : 'configuration_1';
    try {
      const result = await app.runOsnmaVerify(scenario);
      return { ok: true, result };
    } catch (e) {
      return reply.code(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        hint: 'Start sidecar: npm run osnma (after scripts/setup-osnma.sh)',
      });
    }
  });

  server.get('/api/live', async () => ({
    status: app.live.status(),
    vessels: app.live.getVessels().map((v) => ({ ...v, origin: 'live' as const })),
  }));

  server.get('/api/lab', async () => ({
    ...app.snapshot().lab,
    use_historical: app.useHistoricalLab,
    injection_policy: 'simulated_only',
    simulated_ships: app.simulatedShipIds(),
  }));

  server.post('/api/view-mode', async (req, reply) => {
    const body = req.body as { mode?: string };
    if (body.mode !== 'both' && body.mode !== 'live' && body.mode !== 'lab') {
      return reply.code(400).send({ error: 'mode must be both|live|lab' });
    }
    app.setViewMode(body.mode);
    return { ok: true, view_mode: app.viewMode, snapshot: app.snapshot() };
  });

  // —— Cybersecurity console APIs ——
  const { THREAT_MODEL } = await import('./security/threatModel.js');
  const { verifyAuditChainWithShore } = await import('./security/auditVerify.js');

  server.get('/api/security/threat-model', async () => THREAT_MODEL);
  server.get('/api/security/events', async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return { events: app.forensics.list(limit) };
  });
  server.get('/api/audit/verify', async () => {
    if (app.audit.broken) {
      return {
        ok: false,
        chain_ok: false,
        checkpoint_ok: false,
        fail_closed: true,
        broken_path: app.audit.brokenPath,
        reason: 'Audit log is fail-closed after a broken chain — re-anchor required',
        entries: app.audit.tip.seq,
        tip: app.audit.tip.hash,
      };
    }
    const result = await verifyAuditChainWithShore(app.shore);
    if (!result.ok) {
      app.forensics.push(
        'audit_tamper_detected',
        result.reason ?? 'Audit chain broken',
        { ...result },
        'critical',
      );
    }
    return result;
  });
  server.post('/api/audit/reanchor', { preHandler: requireScope('audit') }, async () => {
    const { writeAuditCheckpoint } = await import('./security/auditCheckpoint.js');
    app.audit.reanchor();
    const tip = app.audit.tip;
    await writeAuditCheckpoint(
      app.shore,
      { seq: tip.seq, tip_hash: tip.hash, entry_count: tip.seq },
      app.env.auditMirrorPath,
    );
    app.audit.append('audit_reanchored', { by: 'admin' });
    return {
      ok: true,
      tip: app.audit.tip,
      note: 'Fail-closed cleared; new audit chain started',
    };
  });
  server.post<{ Params: { deviceId: string } }>(
    '/api/challenge/:deviceId',
    async (req, reply) => issueSignedChallenge(req.params.deviceId, req.body, reply),
  );
  // P4.1: enrolment requires the admin bearer or X-Northstar-Enrol-Token (generated on
  // first run into NORTHSTAR_DATA_DIR/enrol.token; the device-sim reads it). Shore still
  // never generates device secrets. A vessel with an active device cannot gain a second
  // one unless an admin sends replace: true.
  app.enrolToken();
  server.post('/api/devices/enrol', async (req, reply) => {
    const dec = authorizeAdmin(req.headers.authorization, 'devices', adminToken, principals);
    const isAdmin = dec.ok && dec.principal !== 'tests' && !!req.headers.authorization;
    const tokenHeader = req.headers['x-northstar-enrol-token'];
    const result = await app.enrolDevice(
      (req.body ?? {}) as Parameters<typeof app.enrolDevice>[0],
      {
        admin: isAdmin,
        enrolToken: Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader,
      },
    );
    return reply.code(result.status).send(result.body);
  });
  server.get('/api/lab/clock', async () => app.labClock());
  /** Lab-return events (times and kinds only, no raw data) for jump-to controls. */
  server.get('/api/lab/events', async () => app.labEvents() ?? { events: [] });
  server.post('/api/lab/seek', { preHandler: requireScope('scenario') }, async (req, reply) => {
    const t = Date.parse(String((req.body as { t?: string } | undefined)?.t ?? ''));
    if (Number.isNaN(t)) return reply.code(400).send({ error: 't (ISO time) required' });
    const r = app.seekLab(t);
    if (!r.ok) return reply.code(409).send({ error: 'historical lab not active' });
    return r;
  });
  /** Imported lab returns (scripts/lab/import_lab_return.py → data/lab/<id>/): readiness only, no raw rows. */
  server.get('/api/lab/returns', async () => {
    const root = join(REPO_ROOT, 'data', 'lab');
    return listLabReturns(root).map((id) => {
      const r = loadLabReturn(root, id);
      return r ? labReturnSummary(r) : { id, error: 'unreadable' };
    });
  });
  /** Demo: signed envelope without challenge_nonce → fail closed when required. */
  server.post('/api/demo/challenge-miss', { preHandler: requireScope('demo') }, async () => {
    const { generateKeyPair, signPayload, bytesToB64 } = await import('@northstar/core');
    const target = app.fullstackEntityId() ?? 'VESSEL-001';
    const { privateKey, publicKey } = await generateKeyPair();
    const deviceId = 'DEV-CHALLENGE-MISS';
    await app.registry.enroll({
      device_id: deviceId,
      entity_id: target,
      public_key_b64: bytesToB64(publicKey),
    });
    const enrolled = app.registry.get(deviceId)!;
    const payload = {
      v: 1 as const,
      device_id: deviceId,
      entity_id: target,
      sequence_number: Date.now() % 1_000_000,
      timestamp: new Date().toISOString(),
      firmware_version: '1.0.0',
      position: { lat: 59.9, lon: 25.0, crs: 'EPSG:4326' as const },
      speed_over_ground_knots: 10,
      course_over_ground_deg: 90,
      // intentionally omit challenge_nonce
    };
    const signature = await signPayload(payload, privateKey);
    const result = await app.ingestSigned({
      payload,
      signature,
      public_key_id: enrolled.key_id,
      assurance_level: 'software',
      signature_alg: 'ed25519',
    });
    return {
      ok: result.ok,
      expected: 'challenge_required or challenge_rejected',
      result,
      note: 'Fail-closed demo when NORTHSTAR_CHALLENGE_REQUIRED=true',
    };
  });
  server.post<{ Params: { id: string } }>(
    '/api/devices/:id/rotate',
    { preHandler: requireScope('devices') },
    async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { new_public_key_b64?: string };
      return await app.rotateDevice(req.params.id, body.new_public_key_b64);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
    },
  );
  server.post<{ Params: { id: string } }>(
    '/api/devices/:id/revoke',
    { preHandler: requireScope('devices') },
    async (req, reply) => {
    const enrollment = await app.revokeDevice(req.params.id);
    if (!enrollment) return reply.code(404).send({ error: 'unknown device' });
    return { ok: true, enrollment };
    },
  );
  server.get('/api/devices/revocation', async () => ({
    events: app.revocation.list(),
    note: 'Shore-signed CRL-lite — ingest rejects listed keys even if devices.json is revived',
  }));
  server.get('/api/security/summary', async () => ({
    threat_model_adversaries: THREAT_MODEL.adversaries.length,
    role: app.env.role,
    challenge_required: app.env.challengeRequired,
    osnma_scope: app.env.osnmaScope,
    mtls: app.env.mtlsEnabled,
    devices: app.registry.list().map((d) => ({
      device_id: d.device_id,
      entity_id: d.entity_id,
      key_id: d.key_id,
      revoked: !!d.revoked_at,
      assurance_level: d.assurance_level,
      signature_alg: d.signature_alg ?? 'ed25519',
      public_key_prefix: d.public_key.slice(0, 20),
    })),
    recent_events: app.forensics.list(12),
    audit: await verifyAuditChainWithShore(app.shore),
    osnma: {
      sidecar: app.osnmaClient.status,
      result: app.getOsnmaDemoStatus(),
      lab_protocol: app.snapshot().lab?.osnma_protocol_status,
    },
    last_telemetry_hash: app.lastTelemetryHash,
    controls: [
      'Ed25519 + JCS canonicalization (software) / ECDSA P-256 (PKCS#11)',
      'ReplayGuard (seq + hash + freshness)',
      app.env.challengeRequired ? 'Challenge nonce (required)' : 'Challenge nonce (optional)',
      'Key rotate / revoke + shore-signed revocation list',
      'SHA-256 audit hash chain + shore-signed tip checkpoint',
      'OSNMAlib ICD TESLA/MAC (fullstack Hist Lab only by default)',
      app.labFolder ? 'Recorded multi-element RF AoA for the lab vessel' : '2-ant lab IQ AoA (full-stack Hist Lab only)',
      app.env.mtlsEnabled
        ? 'mTLS on telemetry (channel identity)'
        : 'mTLS available (NORTHSTAR_TLS_ENABLED + MTLS_ENABLED)',
      'Plain-HTTP telemetry refused on network binds (TLS device server)',
      'Scoped admin tokens (scenario / rf / osnma / audit / devices / demo)',
      'One-time, per-vessel enrolment tokens (hashed, expiring)',
      'Attacks injected only into simulated ships',
      'Seeded fuzzing of untrusted inputs + SBOM in CI',
    ],
    rf: app.getRfLabResult(),
    fullstack_entity_id: app.fullstackEntityId(),
    revocation_count: app.revocation.list().length,
  }));

  server.get('/api/security/export', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const auditPath = join(REPO_ROOT, 'data/fixtures/audit.jsonl');
    const auditTail = existsSync(auditPath)
      ? readFileSync(auditPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .slice(-100)
          .map((l) => JSON.parse(l))
      : [];
    return {
      exported_at: new Date().toISOString(),
      product: 'Northstar',
      role: app.env.role,
      forensics: app.forensics.list(100),
      audit_tail: auditTail,
      audit_verify: await verifyAuditChainWithShore(app.shore),
      last_telemetry_hash: app.lastTelemetryHash,
      devices: app.registry.list(),
      revocation: app.revocation.list(),
      osnma: app.getOsnmaDemoStatus(),
      threat_model: THREAT_MODEL,
      note: 'Payload signature = provenance; mTLS client cert = channel identity (when enabled).',
    };
  });

  // Display copies of the polygon layers: simplified once, cached, gzipped on request.
  // ?detail=full serves the exact geometry the checks use.
  const { simplifyForDisplay } = await import('./geo/displaySimplify.js');
  const { gzipSync } = await import('node:zlib');
  const geoCache = new Map<string, { json: string; gz: Buffer }>();
  server.get('/api/geo/:layer', async (req, reply) => {
    const layer = (req.params as { layer: string }).layer;
    const full = (req.query as { detail?: string }).detail === 'full';
    const map: Record<string, unknown> = {
      land: app.geo.landGeoJson,
      ports: app.geo.portsGeoJson,
      lanes: app.geo.lanesGeoJson,
      restricted: app.geo.restrictedGeoJson,
    };
    if (!map[layer]) return reply.code(404).send({ error: 'unknown_layer' });
    const key = `${layer}:${full ? 'full' : 'display'}`;
    let c = geoCache.get(key);
    if (!c) {
      const src = map[layer] as Parameters<typeof simplifyForDisplay>[0];
      const data = full
        ? src
        : layer === 'land'
          ? simplifyForDisplay(src)
          : layer === 'ports'
            ? simplifyForDisplay(src, 0.00005, 0) // keep every quay/pier
            : src;
      const json = JSON.stringify(data);
      c = { json, gz: gzipSync(json) };
      geoCache.set(key, c);
    }
    reply.header('content-type', 'application/json; charset=utf-8').header('cache-control', 'public, max-age=3600');
    reply.header('vary', 'accept-encoding');
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      return reply.header('content-encoding', 'gzip').send(c.gz);
    }
    return reply.send(c.json);
  });

  server.post('/api/scenario', {
    preHandler: requireScope('scenario'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = ScenarioCommandSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const applied = app.setScenario(parsed.data.scenario, parsed.data.entity_id);
    return { ok: true, ...applied, snapshot: app.snapshot() };
  });

  server.post('/api/select', async (req, reply) => {
    const body = req.body as { entity_id?: string };
    if (!body.entity_id) return reply.code(400).send({ error: 'entity_id required' });
    app.selectedEntityId = body.entity_id;
    return { ok: true };
  });

  /** One-time, per-vessel enrolment token (admin scope 'devices'); returned once, stored hashed. */
  server.post('/api/devices/enrol-tokens', { preHandler: requireScope('devices') }, async (req, reply) => {
    const body = (req.body ?? {}) as { entity_id?: string; ttl_s?: number };
    if (!body.entity_id || !/^[A-Za-z0-9_-]{3,64}$/.test(body.entity_id)) {
      return reply.code(400).send({ error: 'entity_id required' });
    }
    const dec = authorizeAdmin(req.headers.authorization, 'devices', adminToken, principals);
    return { ok: true, entity_id: body.entity_id, ...app.issueEnrolToken(body.entity_id, body.ttl_s ?? 3600, dec.ok ? dec.principal : 'unknown') };
  });

  server.post('/api/telemetry', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!allowPlaintextDevice) {
      return reply.code(403).send({ error: 'tls_required', hint: 'send telemetry to the TLS device server' });
    }
    const parsed = SignedTelemetryEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_envelope', detail: parsed.error.message });
    if (!checkDeviceRate(parsed.data.payload.device_id)) {
      return reply.code(429).send({ error: 'device_rate_limit_exceeded' });
    }
    const result = await app.ingestSigned(parsed.data);
    if (!result.ok) return reply.code(401).send(result);
    return result;
  });

  server.get('/api/audit/tail', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const path = join(REPO_ROOT, 'data/fixtures/audit.jsonl');
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-50).map((l) => JSON.parse(l));
  });

  server.get('/ws', {
    websocket: true,
    preValidation: async (req, reply) => {
      if (!wsTokenOk(req.query, req.headers.authorization, wsToken)) {
        return reply.code(401).send({ error: 'ws_token_required' });
      }
    },
  }, (socket) => {
    const unsub = app.subscribe((msg) => {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        /* closed */
      }
    });
    socket.on('close', () => unsub());
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; entity_id?: string };
        if (msg.type === 'select' && msg.entity_id) {
          app.selectedEntityId = msg.entity_id;
        }
      } catch {
        /* ignore */
      }
    });
  });

  await server.listen({ host: app.env.host, port: app.env.httpPort });

  if (
    app.env.tlsEnabled &&
    existsSync(join(app.env.certDir, 'server.crt')) &&
    existsSync(join(app.env.certDir, 'server.key'))
  ) {
    const deviceServer = Fastify({
      logger: true,
      https: {
        key: readFileSync(join(app.env.certDir, 'server.key')),
        cert: readFileSync(join(app.env.certDir, 'server.crt')),
        ca: existsSync(join(app.env.certDir, 'ca.crt'))
          ? readFileSync(join(app.env.certDir, 'ca.crt'))
          : undefined,
        requestCert: app.env.mtlsEnabled,
        rejectUnauthorized: app.env.mtlsEnabled,
      },
    });
    await deviceServer.register(cors, {
      origin: (origin, cb) => cb(null, !origin || corsOrigins.has(origin)),
    });
    deviceServer.post('/api/telemetry', async (req, reply) => {
      if (app.env.mtlsEnabled) {
        const peer = (req.raw as { socket?: { authorized?: boolean } }).socket;
        // Node TLS socket exposes authorized when requestCert is set
        const tlsSocket = req.raw.socket as import('node:tls').TLSSocket;
        if (app.env.mtlsEnabled && tlsSocket.authorized === false) {
          return reply.code(401).send({
            ok: false,
            reason: 'mtls_required',
            note: 'Client certificate required for telemetry',
          });
        }
        void peer;
      }
      const parsed = SignedTelemetryEnvelopeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_envelope', detail: parsed.error.message });
      }
      if (!checkDeviceRate(parsed.data.payload.device_id)) {
        return reply.code(429).send({ error: 'device_rate_limit_exceeded' });
      }
      const result = await app.ingestSigned(parsed.data);
      if (!result.ok) return reply.code(401).send(result);
      return result;
    });
    deviceServer.post<{ Params: { deviceId: string } }>(
      '/api/challenge/:deviceId',
      async (req, reply) => issueSignedChallenge(req.params.deviceId, req.body, reply),
    );
    await deviceServer.listen({ host: app.env.host, port: app.env.port });
    console.log(
      `Northstar device HTTPS${app.env.mtlsEnabled ? '+mTLS' : ''} on https://${app.env.host}:${app.env.port}`,
    );
  }

  app.start();
  console.log(
    `Northstar web http://${app.env.host}:${app.env.httpPort} [${app.env.dataMode}] role=${app.env.role} challenge=${app.env.challengeRequired}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
