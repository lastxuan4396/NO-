const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENV || process.env.NODE_ENV || 'production'
    });
  } catch (error) {
    console.error('[sentry] init failed', error);
  }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const port = Number(process.env.PORT || 10000);
const defaultBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim();
const storageMode = String(process.env.SHORTLINK_STORAGE || '').trim().toLowerCase();
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const storeFile = process.env.SHORTLINK_STORE_FILE || path.join(__dirname, 'shortlinks-store.json');

const shortlinkTtlDays = Math.max(1, Number(process.env.SHORTLINK_TTL_DAYS || 30));
const cleanupIntervalMs = Math.max(60000, Number(process.env.SHORTLINK_CLEANUP_INTERVAL_MS || 600000));
const rateLimitWindowMs = Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60000));
const rateLimitWriteMax = Math.max(1, Number(process.env.RATE_LIMIT_WRITE_MAX || 40));
const rateLimitReadMax = Math.max(1, Number(process.env.RATE_LIMIT_READ_MAX || 160));

const turnstileSecretKey = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
const shortlinkPinSecret = String(process.env.SHORTLINK_PIN_SECRET || 'nvc-pin-secret-v1');

const allowedOrigins = new Set(
  String(process.env.CORS_ALLOW_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

const RATE_BUCKETS = new Map();
const ROOMS = new Map();

const APP_METRICS = {
  shortlink_create_total: 0,
  shortlink_read_total: 0,
  shortlink_read_miss_total: 0,
  shortlink_read_denied_total: 0,
  shortlink_store_state_total: 0,
  shortlink_store_sealed_total: 0,
  shortlink_renew_total: 0,
  shortlink_clone_total: 0,
  room_join_total: 0,
  room_update_total: 0,
  ratelimit_block_total: 0,
  captcha_fail_total: 0,
  internal_error_total: 0
};

function bumpMetric(name, delta = 1) {
  APP_METRICS[name] = Number(APP_METRICS[name] || 0) + delta;
}

function nowIso() {
  return new Date().toISOString();
}

function getExpireIsoFrom(baseIso, days = shortlinkTtlDays) {
  const base = new Date(baseIso).getTime();
  return new Date(base + Math.max(1, days) * 86400 * 1000).toISOString();
}

function ensureStoreDir() {
  const dir = path.dirname(storeFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function parseJsonFile(filepath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return fallback;
  }
}

function generateId(length = 7) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const random = crypto.randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i += 1) {
    id += chars[random[i] % chars.length];
  }
  return id;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hashPin(pin) {
  return sha256(`${shortlinkPinSecret}:${String(pin)}`);
}

function sanitizeState(rawState) {
  if (!rawState || typeof rawState !== 'object') {
    return null;
  }
  return {
    observation: String(rawState.observation || '').slice(0, 1200),
    request: String(rawState.request || '').slice(0, 1200),
    customFeeling: String(rawState.customFeeling || '').slice(0, 300),
    customNeed: String(rawState.customNeed || '').slice(0, 300),
    selectedFeelings: Array.isArray(rawState.selectedFeelings) ? rawState.selectedFeelings.slice(0, 6).map((v) => String(v).slice(0, 20)) : [],
    selectedNeeds: Array.isArray(rawState.selectedNeeds) ? rawState.selectedNeeds.slice(0, 6).map((v) => String(v).slice(0, 20)) : []
  };
}

function sanitizeSealed(rawSealed) {
  if (!rawSealed || typeof rawSealed !== 'object') {
    return null;
  }
  const iv = String(rawSealed.iv || '').trim();
  const ct = String(rawSealed.ct || '').trim();
  if (!iv || !ct || iv.length > 128 || ct.length > 12000) {
    return null;
  }
  return {
    v: Number(rawSealed.v || 1),
    alg: String(rawSealed.alg || 'AES-GCM').slice(0, 40),
    iv,
    ct
  };
}

function sanitizePrivacyOptions(rawOptions) {
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const pin = String(options.pin || '').trim();
  const oneTime = Boolean(options.oneTime || options.selfDestruct);
  let maxViews = Number(options.maxViews || 0);
  if (!Number.isFinite(maxViews) || maxViews <= 0) {
    maxViews = oneTime ? 1 : 0;
  }
  if (maxViews > 20) maxViews = 20;

  return {
    oneTime,
    maxViews,
    pinHash: pin ? hashPin(pin) : ''
  };
}

function sanitizeStoredOptions(raw) {
  const options = raw && typeof raw === 'object' ? raw : {};
  return {
    oneTime: Boolean(options.oneTime),
    maxViews: Math.max(0, Number(options.maxViews || 0)),
    pinHash: String(options.pinHash || '')
  };
}

function getPublicPrivacy(options) {
  return {
    oneTime: Boolean(options.oneTime),
    maxViews: Number(options.maxViews || 0),
    requiresPin: Boolean(options.pinHash)
  };
}

function normalizePayloadForResponse(entry) {
  const base = {
    id: entry.id,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    hits: entry.hits,
    privacy: getPublicPrivacy(entry.options)
  };
  if (entry.payloadKind === 'sealed') {
    return { ...base, sealed: entry.payload };
  }
  return { ...base, state: entry.payload };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function shouldAllowOrigin(origin) {
  if (!origin) return true;
  if (!allowedOrigins.size) return true;
  return allowedOrigins.has(origin);
}

function buildBaseUrl(req) {
  if (defaultBaseUrl) {
    return defaultBaseUrl.replace(/\/+$/g, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

async function verifyTurnstileToken(token, remoteIp) {
  if (!turnstileSecretKey) return true;
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return false;
  try {
    const body = new URLSearchParams({
      secret: turnstileSecretKey,
      response: cleanToken,
      remoteip: String(remoteIp || '')
    });
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return Boolean(data && data.success);
  } catch {
    return false;
  }
}

function requestAuditLog(req, res, startedAt) {
  if (!req.path.startsWith('/api/') && req.path !== '/healthz' && req.path !== '/metrics') return;
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const line = {
    t: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl || req.url,
    status: res.statusCode,
    durationMs: Number(durationMs.toFixed(2)),
    ip: getClientIp(req),
    ua: String(req.get('user-agent') || '').slice(0, 140)
  };
  console.log('[access]', JSON.stringify(line));
}

class FileShortlinkStore {
  constructor(filepath) {
    this.filepath = filepath;
    this.store = { links: {} };
  }

  async init() {
    ensureStoreDir();
    const loaded = parseJsonFile(this.filepath, { links: {} });
    this.store = loaded && typeof loaded === 'object' && loaded.links ? loaded : { links: {} };
    return 'file';
  }

  async save() {
    ensureStoreDir();
    fs.writeFileSync(this.filepath, JSON.stringify(this.store), 'utf8');
  }

  async hasId(id) {
    return Boolean(this.store.links[id]);
  }

  async create(entry) {
    this.store.links[entry.id] = {
      payloadKind: entry.payloadKind,
      payload: entry.payload,
      options: sanitizeStoredOptions(entry.options),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      hits: 0
    };
    await this.save();
  }

  async deleteById(id) {
    if (!this.store.links[id]) return false;
    delete this.store.links[id];
    await this.save();
    return true;
  }

  async peekById(id) {
    const raw = this.store.links[id];
    if (!raw) return { reason: 'not_found', entry: null };
    if (raw.expiresAt && new Date(raw.expiresAt).getTime() <= Date.now()) {
      delete this.store.links[id];
      await this.save();
      return { reason: 'expired', entry: null };
    }
    return {
      reason: 'ok',
      entry: {
        id,
        payloadKind: raw.payloadKind || 'state',
        payload: raw.payload || raw.state || null,
        options: sanitizeStoredOptions(raw.options),
        createdAt: raw.createdAt,
        expiresAt: raw.expiresAt,
        hits: Number(raw.hits || 0)
      }
    };
  }

  async updateExpiry(id, expiresAt) {
    if (!this.store.links[id]) return false;
    this.store.links[id].expiresAt = expiresAt;
    await this.save();
    return true;
  }

  async readById(id, { pinHash } = {}) {
    const peek = await this.peekById(id);
    if (peek.reason !== 'ok') return peek;
    const entry = peek.entry;

    if (entry.options.pinHash && !pinHash) return { reason: 'pin_required', entry: null };
    if (entry.options.pinHash && pinHash !== entry.options.pinHash) return { reason: 'pin_invalid', entry: null };

    const raw = this.store.links[id];
    raw.hits = Number(raw.hits || 0) + 1;
    await this.save();

    entry.hits = raw.hits;
    if (entry.options.maxViews > 0 && entry.hits >= entry.options.maxViews) {
      await this.deleteById(id);
    }

    return { reason: 'ok', entry };
  }

  async cleanupExpired() {
    const before = Object.keys(this.store.links).length;
    const now = Date.now();
    for (const [id, item] of Object.entries(this.store.links)) {
      if (item.expiresAt && new Date(item.expiresAt).getTime() <= now) {
        delete this.store.links[id];
      }
    }
    const after = Object.keys(this.store.links).length;
    if (after !== before) {
      await this.save();
    }
    return before - after;
  }
}

class PgShortlinkStore {
  constructor(conn) {
    const { Pool } = require('pg');
    const sslEnabled = String(process.env.DATABASE_SSL || '').toLowerCase() === 'true';
    this.pool = new Pool({
      connectionString: conn,
      ssl: sslEnabled ? { rejectUnauthorized: false } : false
    });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS short_links (
        id TEXT PRIMARY KEY,
        payload JSONB,
        payload_kind TEXT NOT NULL DEFAULT 'state',
        options JSONB NOT NULL DEFAULT '{}'::jsonb,
        state JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0
      )
    `);
    await this.pool.query('ALTER TABLE short_links ADD COLUMN IF NOT EXISTS payload JSONB');
    await this.pool.query("ALTER TABLE short_links ADD COLUMN IF NOT EXISTS payload_kind TEXT NOT NULL DEFAULT 'state'");
    await this.pool.query("ALTER TABLE short_links ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb");
    await this.pool.query('ALTER TABLE short_links ADD COLUMN IF NOT EXISTS state JSONB');
    await this.pool.query('ALTER TABLE short_links ALTER COLUMN state DROP NOT NULL');
    await this.pool.query("UPDATE short_links SET payload = state WHERE payload IS NULL AND state IS NOT NULL");
    await this.pool.query("UPDATE short_links SET payload_kind = 'state' WHERE payload_kind IS NULL OR payload_kind = ''");
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_short_links_expires_at ON short_links (expires_at)');
    return 'postgres';
  }

  async hasId(id) {
    const result = await this.pool.query('SELECT 1 FROM short_links WHERE id = $1 LIMIT 1', [id]);
    return result.rowCount > 0;
  }

  async create(entry) {
    await this.pool.query(
      `INSERT INTO short_links (id, payload, payload_kind, options, state, created_at, expires_at, hits)
       VALUES ($1, $2::jsonb, $3, $4::jsonb, CASE WHEN $3 = 'state' THEN $2::jsonb ELSE '{}'::jsonb END, $5::timestamptz, $6::timestamptz, 0)`,
      [entry.id, JSON.stringify(entry.payload), entry.payloadKind, JSON.stringify(sanitizeStoredOptions(entry.options)), entry.createdAt, entry.expiresAt]
    );
  }

  async deleteById(id) {
    const result = await this.pool.query('DELETE FROM short_links WHERE id = $1', [id]);
    return Number(result.rowCount || 0) > 0;
  }

  async peekById(id) {
    const result = await this.pool.query(
      `SELECT id, payload, payload_kind, options, state, created_at, expires_at, hits
       FROM short_links
       WHERE id = $1
       LIMIT 1`,
      [id]
    );
    if (!result.rowCount) return { reason: 'not_found', entry: null };
    const row = result.rows[0];
    const expiresAt = new Date(row.expires_at).toISOString();
    if (new Date(expiresAt).getTime() <= Date.now()) {
      await this.deleteById(id);
      return { reason: 'expired', entry: null };
    }
    return {
      reason: 'ok',
      entry: {
        id: row.id,
        payloadKind: row.payload_kind || (row.state ? 'state' : 'sealed'),
        payload: row.payload || row.state,
        options: sanitizeStoredOptions(row.options),
        createdAt: new Date(row.created_at).toISOString(),
        expiresAt,
        hits: Number(row.hits || 0)
      }
    };
  }

  async updateExpiry(id, expiresAt) {
    const result = await this.pool.query('UPDATE short_links SET expires_at = $2::timestamptz WHERE id = $1', [id, expiresAt]);
    return Number(result.rowCount || 0) > 0;
  }

  async readById(id, { pinHash } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `SELECT id, payload, payload_kind, options, state, created_at, expires_at, hits
         FROM short_links
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );
      if (!res.rowCount) {
        await client.query('ROLLBACK');
        return { reason: 'not_found', entry: null };
      }

      const row = res.rows[0];
      const options = sanitizeStoredOptions(row.options);
      const expiresAt = new Date(row.expires_at).toISOString();
      if (new Date(expiresAt).getTime() <= Date.now()) {
        await client.query('DELETE FROM short_links WHERE id = $1', [id]);
        await client.query('COMMIT');
        return { reason: 'expired', entry: null };
      }

      if (options.pinHash && !pinHash) {
        await client.query('ROLLBACK');
        return { reason: 'pin_required', entry: null };
      }
      if (options.pinHash && pinHash !== options.pinHash) {
        await client.query('ROLLBACK');
        return { reason: 'pin_invalid', entry: null };
      }

      const upd = await client.query('UPDATE short_links SET hits = hits + 1 WHERE id = $1 RETURNING hits', [id]);
      const hits = Number(upd.rows[0].hits || 0);
      if (options.maxViews > 0 && hits >= options.maxViews) {
        await client.query('DELETE FROM short_links WHERE id = $1', [id]);
      }
      await client.query('COMMIT');

      return {
        reason: 'ok',
        entry: {
          id: row.id,
          payloadKind: row.payload_kind || (row.state ? 'state' : 'sealed'),
          payload: row.payload || row.state,
          options,
          createdAt: new Date(row.created_at).toISOString(),
          expiresAt,
          hits
        }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanupExpired() {
    const result = await this.pool.query('DELETE FROM short_links WHERE expires_at <= NOW()');
    return Number(result.rowCount || 0);
  }
}

function wsBroadcastRoom(roomId, payload) {
  const room = ROOMS.get(roomId);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const member of room.members.values()) {
    if (member.ws.readyState === 1) {
      member.ws.send(data);
    }
  }
}

function wsSendPresence(roomId) {
  const room = ROOMS.get(roomId);
  if (!room) return;
  wsBroadcastRoom(roomId, {
    type: 'room_presence',
    roomId,
    participants: [...room.members.values()].map((member) => ({ clientId: member.clientId, name: member.name }))
  });
}

function normalizeRoomState(rawState) {
  const state = sanitizeState(rawState);
  if (!state) return null;
  return {
    ...state,
    updatedAt: nowIso()
  };
}

function joinRoom(ws, roomId, name, initialState) {
  const safeRoomId = String(roomId || '').trim().slice(0, 40);
  if (!safeRoomId) {
    ws.send(JSON.stringify({ type: 'error', message: 'roomId required' }));
    return;
  }

  if (ws.roomId && ws.roomId !== safeRoomId) {
    leaveRoom(ws);
  }

  let room = ROOMS.get(safeRoomId);
  if (!room) {
    room = {
      roomId: safeRoomId,
      members: new Map(),
      state: null,
      updatedAt: null
    };
    ROOMS.set(safeRoomId, room);
  }

  ws.roomId = safeRoomId;
  ws.clientId = ws.clientId || generateId(10);
  ws.name = String(name || '匿名').trim().slice(0, 24) || '匿名';

  room.members.set(ws.clientId, {
    ws,
    clientId: ws.clientId,
    name: ws.name
  });

  const parsedState = normalizeRoomState(initialState);
  if (parsedState) {
    room.state = parsedState;
    room.updatedAt = parsedState.updatedAt;
  }

  ws.send(
    JSON.stringify({
      type: 'joined',
      roomId: safeRoomId,
      clientId: ws.clientId,
      state: room.state
    })
  );

  wsSendPresence(safeRoomId);
  bumpMetric('room_join_total');
}

function leaveRoom(ws) {
  if (!ws.roomId) return;
  const room = ROOMS.get(ws.roomId);
  if (!room) {
    ws.roomId = null;
    return;
  }
  room.members.delete(ws.clientId);
  const roomId = ws.roomId;
  ws.roomId = null;

  if (!room.members.size) {
    ROOMS.delete(roomId);
    return;
  }
  wsSendPresence(roomId);
}

function handleRoomStateUpdate(ws, state) {
  if (!ws.roomId) {
    ws.send(JSON.stringify({ type: 'error', message: 'join room first' }));
    return;
  }
  const room = ROOMS.get(ws.roomId);
  if (!room) return;

  const normalized = normalizeRoomState(state);
  if (!normalized) return;
  room.state = normalized;
  room.updatedAt = normalized.updatedAt;

  wsBroadcastRoom(ws.roomId, {
    type: 'room_state',
    roomId: ws.roomId,
    by: ws.clientId,
    state: normalized
  });
  bumpMetric('room_update_total');
}

wss.on('connection', (ws) => {
  ws.clientId = generateId(10);
  ws.roomId = null;

  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(String(buf || ''));
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'join') {
        joinRoom(ws, msg.roomId, msg.name, msg.state);
        return;
      }
      if (msg.type === 'sync_state') {
        handleRoomStateUpdate(ws, msg.state);
        return;
      }
      if (msg.type === 'leave') {
        leaveRoom(ws);
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid message' }));
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });
});

function rateLimitMiddleware(req, res, next) {
  if (!req.path.startsWith('/api/shortlinks')) {
    next();
    return;
  }
  const mode = req.method === 'POST' ? 'write' : 'read';
  const limit = mode === 'write' ? rateLimitWriteMax : rateLimitReadMax;
  const ip = getClientIp(req);
  const key = `${mode}:${ip}`;
  const now = Date.now();
  const bucket = RATE_BUCKETS.get(key) || { start: now, count: 0 };
  if (now - bucket.start >= rateLimitWindowMs) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  RATE_BUCKETS.set(key, bucket);
  if (bucket.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((rateLimitWindowMs - (now - bucket.start)) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    bumpMetric('ratelimit_block_total');
    res.status(429).json({ message: 'too many requests' });
    return;
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of RATE_BUCKETS.entries()) {
    if (now - bucket.start > rateLimitWindowMs * 2) {
      RATE_BUCKETS.delete(key);
    }
  }
}, Math.max(10000, rateLimitWindowMs)).unref();

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => requestAuditLog(req, res, startedAt));
  next();
});

app.use(express.json({ limit: '120kb' }));
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (!shouldAllowOrigin(origin)) {
    res.status(403).json({ message: 'origin not allowed' });
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!allowedOrigins.size) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.use(rateLimitMiddleware);

app.locals.shortlinkStore = null;
app.locals.shortlinkStoreMode = 'unknown';

app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'nvc-couple-share',
    store: app.locals.shortlinkStoreMode,
    ttlDays: shortlinkTtlDays,
    captchaEnabled: Boolean(turnstileSecretKey),
    wsRooms: ROOMS.size
  });
});

app.get('/metrics', (_req, res) => {
  const lines = ['# HELP nvc_shortlink_metrics NVC shortlink app counters', '# TYPE nvc_shortlink_metrics gauge'];
  for (const [name, value] of Object.entries(APP_METRICS)) {
    lines.push(`${name} ${Number(value || 0)}`);
  }
  lines.push(`ws_room_count ${ROOMS.size}`);
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.status(200).send(`${lines.join('\n')}\n`);
});

app.post('/api/shortlinks', async (req, res, next) => {
  try {
    const state = sanitizeState(req.body && req.body.state);
    const sealed = sanitizeSealed(req.body && req.body.sealed);
    if (!state && !sealed) {
      res.status(400).json({ message: 'state or sealed is required' });
      return;
    }
    const store = app.locals.shortlinkStore;
    if (!store) {
      res.status(503).json({ message: 'shortlink storage unavailable' });
      return;
    }

    const captchaOk = await verifyTurnstileToken(req.body && req.body.captchaToken, getClientIp(req));
    if (!captchaOk) {
      bumpMetric('captcha_fail_total');
      res.status(403).json({ message: 'captcha verification failed' });
      return;
    }

    const payloadKind = sealed ? 'sealed' : 'state';
    const payload = sealed || state;
    const options = sanitizePrivacyOptions(req.body && req.body.options);

    let id = generateId();
    while (await store.hasId(id)) {
      id = generateId();
    }

    const createdAt = nowIso();
    const expiresAt = getExpireIsoFrom(createdAt);
    await store.create({ id, payloadKind, payload, options, createdAt, expiresAt });

    bumpMetric('shortlink_create_total');
    bumpMetric(payloadKind === 'sealed' ? 'shortlink_store_sealed_total' : 'shortlink_store_state_total');

    const baseUrl = buildBaseUrl(req);
    res.status(201).json({
      id,
      shortUrl: `${baseUrl}/?sid=${id}`,
      expiresAt,
      privacy: getPublicPrivacy(options)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/shortlinks/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ message: 'id is required' });
      return;
    }

    const store = app.locals.shortlinkStore;
    if (!store) {
      res.status(503).json({ message: 'shortlink storage unavailable' });
      return;
    }

    const pin = String(req.query.pin || '').trim();
    const readResult = await store.readById(id, { pinHash: pin ? hashPin(pin) : '' });
    if (readResult.reason === 'not_found' || readResult.reason === 'expired') {
      bumpMetric('shortlink_read_miss_total');
      res.status(404).json({ message: 'short link not found or expired' });
      return;
    }
    if (readResult.reason === 'pin_required') {
      bumpMetric('shortlink_read_denied_total');
      res.status(401).json({ message: 'pin required' });
      return;
    }
    if (readResult.reason === 'pin_invalid') {
      bumpMetric('shortlink_read_denied_total');
      res.status(403).json({ message: 'pin invalid' });
      return;
    }

    bumpMetric('shortlink_read_total');
    res.status(200).json(normalizePayloadForResponse(readResult.entry));
  } catch (error) {
    next(error);
  }
});

app.post('/api/shortlinks/:id/renew', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ message: 'id is required' });
      return;
    }
    const days = Math.max(1, Math.min(180, Number(req.body && req.body.days || shortlinkTtlDays)));
    const pin = String(req.body && req.body.pin || '').trim();

    const store = app.locals.shortlinkStore;
    if (!store) {
      res.status(503).json({ message: 'shortlink storage unavailable' });
      return;
    }
    const peek = await store.peekById(id);
    if (peek.reason !== 'ok') {
      res.status(404).json({ message: 'short link not found or expired' });
      return;
    }
    const entry = peek.entry;
    if (entry.options.pinHash && hashPin(pin) !== entry.options.pinHash) {
      res.status(403).json({ message: 'pin invalid' });
      return;
    }

    const base = Math.max(Date.now(), new Date(entry.expiresAt).getTime());
    const expiresAt = getExpireIsoFrom(new Date(base).toISOString(), days);
    await store.updateExpiry(id, expiresAt);

    bumpMetric('shortlink_renew_total');
    res.status(200).json({ id, expiresAt });
  } catch (error) {
    next(error);
  }
});

app.post('/api/shortlinks/:id/clone', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ message: 'id is required' });
      return;
    }

    const store = app.locals.shortlinkStore;
    if (!store) {
      res.status(503).json({ message: 'shortlink storage unavailable' });
      return;
    }
    const peek = await store.peekById(id);
    if (peek.reason !== 'ok') {
      res.status(404).json({ message: 'short link not found or expired' });
      return;
    }

    const entry = peek.entry;
    const pin = String(req.body && req.body.pin || '').trim();
    if (entry.options.pinHash && hashPin(pin) !== entry.options.pinHash) {
      res.status(403).json({ message: 'pin invalid' });
      return;
    }

    const captchaOk = await verifyTurnstileToken(req.body && req.body.captchaToken, getClientIp(req));
    if (!captchaOk) {
      bumpMetric('captcha_fail_total');
      res.status(403).json({ message: 'captcha verification failed' });
      return;
    }

    let newId = generateId();
    while (await store.hasId(newId)) {
      newId = generateId();
    }

    const createdAt = nowIso();
    const expiresAt = getExpireIsoFrom(createdAt);
    const options = sanitizePrivacyOptions(req.body && req.body.options);
    await store.create({
      id: newId,
      payloadKind: entry.payloadKind,
      payload: entry.payload,
      options,
      createdAt,
      expiresAt
    });

    bumpMetric('shortlink_clone_total');
    const baseUrl = buildBaseUrl(req);
    res.status(201).json({
      id: newId,
      shortUrl: `${baseUrl}/?sid=${newId}`,
      expiresAt,
      privacy: getPublicPrivacy(options)
    });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use(express.static(__dirname, { extensions: ['html'] }));

app.get('*', (_req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(publicIndex)) {
    res.sendFile(publicIndex);
    return;
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error('[error]', error);
  bumpMetric('internal_error_total');
  if (Sentry) {
    Sentry.captureException(error);
  }
  if (res.headersSent) return;
  res.status(500).json({ message: 'internal server error' });
});

async function createStore() {
  const shouldUsePostgres = storageMode === 'postgres' || (!storageMode && databaseUrl);
  if (shouldUsePostgres && databaseUrl) {
    try {
      const store = new PgShortlinkStore(databaseUrl);
      const mode = await store.init();
      return { store, mode };
    } catch (error) {
      console.error('[storage] postgres init failed, fallback to file store', error);
      if (Sentry) {
        Sentry.captureException(error);
      }
    }
  }
  const fileStore = new FileShortlinkStore(storeFile);
  const mode = await fileStore.init();
  return { store: fileStore, mode };
}

async function boot() {
  const { store, mode } = await createStore();
  app.locals.shortlinkStore = store;
  app.locals.shortlinkStoreMode = mode;
  console.log(`[storage] mode=${mode} ttlDays=${shortlinkTtlDays}`);

  setInterval(async () => {
    try {
      const removed = await app.locals.shortlinkStore.cleanupExpired();
      if (removed > 0) {
        console.log(`[cleanup] removed_expired=${removed}`);
      }
    } catch (error) {
      console.error('[cleanup] failed', error);
      if (Sentry) {
        Sentry.captureException(error);
      }
    }
  }, cleanupIntervalMs).unref();

  server.listen(port, '0.0.0.0', () => {
    console.log(`nvc-couple-share listening on ${port}`);
  });
}

boot().catch((error) => {
  console.error('[boot] failed', error);
  if (Sentry) {
    Sentry.captureException(error);
  }
  process.exit(1);
});
