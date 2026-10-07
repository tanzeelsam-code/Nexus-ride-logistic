/**
 * NEXUS LOGISTICS — BACKEND API
 * ===============================
 * Node.js + Fastify REST API
 * Handles: Auth, Trips, Deliveries, Drivers, Payments, Real-time
 * 
 * Install: npm install   (dependencies are listed in package.json)
 */

'use strict';

const Fastify = require('fastify');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { Server: SocketIO } = require('socket.io');
const { z } = require('zod');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const Stripe = require('stripe');
const axios = require('axios');
const pino = require('pino');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ============================================================
// CONFIGURATION
// ============================================================

const isProduction = process.env.NODE_ENV === 'production';

function getEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  return value;
}

function validateRuntimeConfig(cfg) {
  if (!isProduction) return;

  const requiredEnvVars = [
    'DB_PASSWORD',
    'REDIS_PASSWORD',
    'JWT_SECRET',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET'
  ];

  for (const key of requiredEnvVars) {
    if (!process.env[key] || !String(process.env[key]).trim()) {
      throw new Error(`Missing required environment variable in production: ${key}`);
    }
  }

  if (cfg.jwt.secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }

  if (cfg.stripe.secretKey.startsWith('sk_test_')) {
    throw new Error('STRIPE_SECRET_KEY must be a live key in production');
  }

  if (cfg.cors.origins.length === 0) {
    throw new Error('ALLOWED_ORIGINS must be explicitly set in production');
  }
}

const config = {
  port: Number(getEnv('PORT', 3000)),
  host: '0.0.0.0',
  
  db: {
    host: getEnv('DB_HOST', 'localhost'),
    port: Number(getEnv('DB_PORT', 5432)),
    database: getEnv('DB_NAME', 'nexusdb'),
    user: getEnv('DB_USER', 'nexus'),
    password: getEnv('DB_PASSWORD', isProduction ? '' : 'nexus_secret'),
    // Hosted Postgres (e.g. Supabase) requires TLS; local Docker does not.
    ssl: getEnv('DB_SSL', 'false') === 'true' ? { rejectUnauthorized: false } : false,
    max: 20,                          // Connection pool size
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Number(getEnv('DB_CONNECT_TIMEOUT_MS', 2000)),
  },
  
  redis: {
    host: getEnv('REDIS_HOST', 'localhost'),
    port: Number(getEnv('REDIS_PORT', 6379)),
    password: getEnv('REDIS_PASSWORD', isProduction ? '' : 'redis_secret'),
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3,
  },
  
  jwt: {
    secret: getEnv('JWT_SECRET', isProduction ? '' : 'dev_nexus_jwt_secret_please_change_me_32_chars'),
    expiresIn: getEnv('JWT_EXPIRES_IN', '24h'),
    refreshExpiresIn: getEnv('JWT_REFRESH_EXPIRES_IN', '30d'),
  },
  
  stripe: {
    secretKey: getEnv('STRIPE_SECRET_KEY', isProduction ? '' : 'sk_test_123'),
    webhookSecret: getEnv('STRIPE_WEBHOOK_SECRET', isProduction ? '' : 'whsec_123'),
  },
  
  ai: {
    baseUrl: getEnv('AI_ENGINE_URL', 'http://localhost:8001'),
  },
  
  maps: {
    apiKey: getEnv('MAPBOX_API_KEY', ''),
  },

  cors: {
    origins: getEnv('ALLOWED_ORIGINS', '').split(',').map((origin) => origin.trim()).filter(Boolean),
  },
  
  app: {
    bcryptRounds: 12,
    maxLoginAttempts: 5,
    loginLockoutMinutes: 30,
    driverSearchRadiusKm: 10,
    dispatchTimeoutSec: 30,
  }
};

function parseDurationToSeconds(input, fallbackSeconds) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input !== 'string') return fallbackSeconds;
  const match = input.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) return fallbackSeconds;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 's') return value;
  if (unit === 'm') return value * 60;
  if (unit === 'h') return value * 3600;
  if (unit === 'd') return value * 86400;
  return fallbackSeconds;
}

const accessTokenTtlSeconds = parseDurationToSeconds(config.jwt.expiresIn, 86400);
const refreshTokenTtlSeconds = parseDurationToSeconds(config.jwt.refreshExpiresIn, 2592000);
const idempotencyTtlSeconds = Number(getEnv('IDEMPOTENCY_TTL_SECONDS', 86400));
const idempotencyProcessingTtlSeconds = Number(getEnv('IDEMPOTENCY_PROCESSING_TTL_SECONDS', 600));

// ============================================================
// LOGGER
// ============================================================

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Pretty output is for local development only; production logs stay structured JSON.
  ...(isProduction ? {} : {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' }
    }
  })
});

const metrics = {
  startedAtMs: Date.now(),
  requestsTotal: 0,
  requestDurationMsSum: 0,
  requestDurationMsCount: 0,
  authFailuresTotal: 0,
  statusCounts: new Map(),
};

function incrementStatusCount(statusCode) {
  const current = metrics.statusCounts.get(statusCode) || 0;
  metrics.statusCounts.set(statusCode, current + 1);
}

function formatPrometheusMetrics() {
  const lines = [
    '# HELP nexus_requests_total Total HTTP requests served by the API.',
    '# TYPE nexus_requests_total counter',
    `nexus_requests_total ${metrics.requestsTotal}`,
    '# HELP nexus_request_duration_ms_sum Total request duration in milliseconds.',
    '# TYPE nexus_request_duration_ms_sum counter',
    `nexus_request_duration_ms_sum ${metrics.requestDurationMsSum}`,
    '# HELP nexus_request_duration_ms_count Total number of timed requests.',
    '# TYPE nexus_request_duration_ms_count counter',
    `nexus_request_duration_ms_count ${metrics.requestDurationMsCount}`,
    '# HELP nexus_auth_failures_total Total authentication failures.',
    '# TYPE nexus_auth_failures_total counter',
    `nexus_auth_failures_total ${metrics.authFailuresTotal}`,
    '# HELP nexus_requests_by_status_total Requests grouped by HTTP status code.',
    '# TYPE nexus_requests_by_status_total counter',
    '# HELP nexus_process_uptime_seconds API process uptime in seconds.',
    '# TYPE nexus_process_uptime_seconds gauge',
    `nexus_process_uptime_seconds ${Math.floor(process.uptime())}`,
    '# HELP nexus_process_resident_memory_bytes Resident set size memory in bytes.',
    '# TYPE nexus_process_resident_memory_bytes gauge',
    `nexus_process_resident_memory_bytes ${process.memoryUsage().rss}`
  ];

  for (const [statusCode, count] of metrics.statusCounts.entries()) {
    lines.push(`nexus_requests_by_status_total{status_code="${statusCode}"} ${count}`);
  }

  return `${lines.join('\n')}\n`;
}

// ============================================================
// DATABASE & IN-MEMORY STORE
// ============================================================

let dbConnected = false;
let redisConnected = false;

const inMemoryStore = {
  drivers: [
    { id: 'drv_01', name: 'Marcus Brooks', lat: 40.7580, lng: -73.9855, mode: 'both', vehicle_type: 'sedan', service_types: ['taxi', 'freight'], status: 'available', rating: 4.9, battery_pct: 92 },
    { id: 'drv_02', name: 'Elena Vance', lat: 40.7484, lng: -73.9857, mode: 'ride', vehicle_type: 'luxury', service_types: ['taxi', 'airport'], status: 'on_trip', rating: 4.95, battery_pct: 78 },
    { id: 'drv_03', name: 'Carlos Morales', lat: 40.7614, lng: -73.9776, mode: 'freight', vehicle_type: 'van', service_types: ['freight', 'cold_chain'], status: 'available', rating: 4.85, battery_pct: 85 },
    { id: 'drv_04', name: 'Aisha Patel', lat: 40.7282, lng: -73.9942, mode: 'both', vehicle_type: 'suv', service_types: ['taxi', 'freight'], status: 'available', rating: 4.92, battery_pct: 94 },
    { id: 'drv_05', name: 'Kenji Takahashi', lat: 40.7505, lng: -73.9934, mode: 'freight', vehicle_type: 'refrigerated', service_types: ['cold_chain', 'freight'], status: 'on_trip', rating: 4.88, battery_pct: 65 },
    { id: 'drv_06', name: 'Sarah Lindqvist', lat: 40.7308, lng: -73.9973, mode: 'ride', vehicle_type: 'hatchback', service_types: ['taxi'], status: 'available', rating: 4.79, battery_pct: 88 },
    { id: 'drv_07', name: 'Darnell Jackson', lat: 40.7061, lng: -74.0092, mode: 'both', vehicle_type: 'van', service_types: ['taxi', 'freight'], status: 'available', rating: 4.86, battery_pct: 73 },
    { id: 'drv_08', name: 'Chloe Dubois', lat: 40.7829, lng: -73.9654, mode: 'ride', vehicle_type: 'sedan', service_types: ['taxi', 'airport'], status: 'available', rating: 4.91, battery_pct: 90 },
    { id: 'drv_09', name: 'Riku Park', lat: 40.7418, lng: -73.9893, mode: 'freight', vehicle_type: 'refrigerated', service_types: ['cold_chain'], status: 'on_trip', rating: 4.82, battery_pct: 69 },
    { id: 'drv_10', name: 'Amara Solano', lat: 40.7180, lng: -74.0020, mode: 'both', vehicle_type: 'sedan', service_types: ['taxi', 'courier'], status: 'available', rating: 4.89, battery_pct: 84 },
  ],
  trips: [
    { id: 'TRP-982341', from: '5th Ave & 42nd St', to: 'JFK Airport', status: 'in_progress', driver: 'Marcus Brooks', fare: 48.50, eta: '12 min', type: 'taxi', progress_pct: 65 },
    { id: 'TRP-982340', from: 'Central Park N', to: 'Brooklyn Bridge', status: 'driver_en_route', driver: 'Sarah Lindqvist', fare: 26.80, eta: '4 min pickup', type: 'taxi', progress_pct: 20 },
    { id: 'TRP-982339', from: 'Times Square', to: 'LaGuardia Airport', status: 'searching', driver: null, fare: 42.00, eta: 'Finding driver...', type: 'taxi', progress_pct: 0 },
    { id: 'TRP-982338', from: 'Midtown East', to: 'Harlem', status: 'completed', driver: 'Elena Vance', fare: 21.20, eta: 'Done', type: 'taxi', progress_pct: 100 },
  ],
  deliveries: [
    { id: 'DEL-44201', from: 'Port Newark Terminal', to: '123 Madison Ave', status: 'in_transit', driver: 'Carlos Morales', fare: 85.00, weight: '45 kg', type: 'freight', vehicle: 'Van', progress_pct: 55 },
    { id: 'DEL-44200', from: 'Cold Storage Hub B', to: 'Bellevue Hospital / Lab', status: 'in_transit', driver: 'Kenji Takahashi', fare: 145.00, weight: '200 kg', type: 'cold_chain', vehicle: 'Reefer Van', current_temp_c: 4.2, temp_target: '2°C–6°C', progress_pct: 70 },
    { id: 'DEL-44199', from: 'SoHo E-Comm Depot', to: 'Chelsea Market', status: 'picked_up', driver: 'Amara Solano', fare: 32.50, weight: '8 kg', type: 'courier', vehicle: 'Sedan', progress_pct: 25 },
    { id: 'DEL-44207', from: 'Fresh Logistics Terminal', to: 'Uptown Gourmet', status: 'in_transit', driver: 'Riku Park', fare: 110.00, weight: '120 kg', type: 'cold_chain', vehicle: 'Reefer Truck', current_temp_c: 5.8, temp_target: '0°C–4°C', progress_pct: 80 },
  ],
  coldChainShipments: [
    { id: 'DEL-44200', cargo: 'Biological Vaccines', driver: 'Kenji Takahashi', plate: 'NX-REF-01', current_temp_c: 4.2, min_temp_c: 2.0, max_temp_c: 6.0, status: 'NORMAL', battery: '91%', updated_at: new Date().toISOString() },
    { id: 'DEL-44207', cargo: 'Organic Dairy & Seafood', driver: 'Riku Park', plate: 'NX-REF-02', current_temp_c: 5.8, min_temp_c: 0.0, max_temp_c: 4.0, status: 'WARNING', battery: '84%', updated_at: new Date().toISOString() },
  ],
  alerts: [
    { id: 'ALT-1', type: 'warning', icon: '🌡️', title: 'Cold Chain Excursion: DEL-44207', desc: 'Temperature reading 5.8°C (Max threshold: 4.0°C). Compressor adjustment advised.', time: '3 min ago', timestamp: Date.now() - 180000 },
    { id: 'ALT-2', type: 'info', icon: '🔄', title: 'Diurnal Fleet Rebalance Executed', desc: '14 off-peak sedan drivers auto-assigned to e-commerce freight & courier queue. Deadhead reduced -34%.', time: '12 min ago', timestamp: Date.now() - 720000 },
    { id: 'ALT-3', type: 'warning', icon: '⚡', title: 'Surge: Downtown Financial District', desc: 'Demand/Supply ratio at 1.9x. Ride surge activated at 1.6x.', time: '25 min ago', timestamp: Date.now() - 1500000 },
  ],
  cache: new Map(),
  kv: new Map(),
};

const db = new Pool({
  ...config.db,
  connectionTimeoutMillis: 2000,
});

db.on('error', (err) => {
  dbConnected = false;
  logger.warn({ msg: err.message }, 'Database pool warning; operating with fallback state if needed');
});

async function query(sql, params) {
  const start = Date.now();
  try {
    const result = await db.query(sql, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn({ sql: sql.substring(0, 100), duration }, 'Slow query detected');
    }
    return result;
  } catch (err) {
    // Demo mode: with no database reachable in development, reads return nothing.
    // Once the database is connected every error surfaces so bugs are not hidden.
    if (!isProduction && !dbConnected) {
      return { rows: [], rowCount: 0 };
    }
    logger.error({ err, sql: sql.substring(0, 100) }, 'Query error');
    throw err;
  }
}

async function transaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function ensureOperationalTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      signature TEXT,
      delivery_attempt INTEGER NOT NULL DEFAULT 1,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      processing_error TEXT
    )
  `);

  await query('CREATE INDEX IF NOT EXISTS idx_stripe_webhooks_received_at ON stripe_webhook_events(received_at DESC)');

  // Proof of delivery: who signed for it. Added after the initial schema.
  await query('ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS dropoff_recipient_name VARCHAR(100)');
}

// ============================================================
// REDIS
// ============================================================

const redis = new Redis({
  ...config.redis,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
  retryStrategy: (times) => (times > 2 ? null : 500)
});

redis.on('error', () => {
  redisConnected = false;
});

redis.on('close', () => {
  redisConnected = false;
});

redis.on('ready', () => {
  redisConnected = true;
});

redis.on('connect', () => {
  redisConnected = true;
  logger.info('✅ Redis connected');
});

// Redis helpers with in-memory fallback
const Cache = {
  async get(key) {
    if (!redisConnected) return inMemoryStore.cache.get(key) || null;
    try {
      const val = await redis.get(key);
      return val ? JSON.parse(val) : null;
    } catch {
      return inMemoryStore.cache.get(key) || null;
    }
  },
  async set(key, value, ttlSeconds = 300) {
    if (!redisConnected) {
      inMemoryStore.cache.set(key, value);
      return;
    }
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
      inMemoryStore.cache.set(key, value);
    }
  },
  async del(key) {
    if (!redisConnected) {
      inMemoryStore.cache.delete(key);
      return;
    }
    try {
      await redis.del(key);
    } catch {
      inMemoryStore.cache.delete(key);
    }
  },
  async incr(key, ttlSeconds) {
    if (!redisConnected) {
      const cur = (inMemoryStore.cache.get(key) || 0) + 1;
      inMemoryStore.cache.set(key, cur);
      return cur;
    }
    try {
      const val = await redis.incr(key);
      if (val === 1 && ttlSeconds) await redis.expire(key, ttlSeconds);
      return val;
    } catch {
      const cur = (inMemoryStore.cache.get(key) || 0) + 1;
      inMemoryStore.cache.set(key, cur);
      return cur;
    }
  }
};


// Key/value store used for sessions, lockouts and idempotency. Uses Redis when
// connected; in development it falls back to process memory so the API still works.
const kv = {
  async get(key) {
    if (redisConnected) return redis.get(key);
    if (isProduction) throw new Error('Redis unavailable');
    const hit = inMemoryStore.kv.get(key);
    if (!hit) return null;
    if (hit.exp && hit.exp < Date.now()) { inMemoryStore.kv.delete(key); return null; }
    return hit.value;
  },
  async setex(key, ttlSeconds, value) {
    if (redisConnected) return redis.setex(key, ttlSeconds, value);
    if (isProduction) throw new Error('Redis unavailable');
    inMemoryStore.kv.set(key, { value, exp: Date.now() + ttlSeconds * 1000 });
    return 'OK';
  },
  async set(key, value, ...args) {
    if (redisConnected) return redis.set(key, value, ...args);
    if (isProduction) throw new Error('Redis unavailable');
    const nx = args.includes('NX');
    const exIdx = args.indexOf('EX');
    const ttl = exIdx >= 0 ? Number(args[exIdx + 1]) : 0;
    if (nx && (await kv.get(key)) !== null) return null;
    inMemoryStore.kv.set(key, { value, exp: ttl ? Date.now() + ttl * 1000 : 0 });
    return 'OK';
  },
  async del(key) {
    if (redisConnected) return redis.del(key);
    if (isProduction) throw new Error('Redis unavailable');
    return inMemoryStore.kv.delete(key) ? 1 : 0;
  },
};

// ============================================================
// FASTIFY APP
// ============================================================

const app = Fastify({
  logger: false,  // Using custom pino logger
  trustProxy: true,
  bodyLimit: 5 * 1024 * 1024,  // 5MB
});

// Plugins
app.register(require('@fastify/cors'), {
  origin: (origin, cb) => {
    // Non-browser clients (curl/mobile) may have no Origin header.
    if (!origin) return cb(null, true);

    // In non-production, allow all origins for rapid local iteration.
    if (!isProduction && config.cors.origins.length === 0) {
      return cb(null, true);
    }

    if (config.cors.origins.includes(origin)) {
      return cb(null, true);
    }

    return cb(new Error('Origin not allowed'), false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
});

app.register(require('@fastify/jwt'), {
  secret: config.jwt.secret,
  sign: { expiresIn: config.jwt.expiresIn }
});

app.register(require('@fastify/rate-limit'), {
  global: true,
  max: 100,
  timeWindow: '1 minute',
  redis,
  // If Redis is unreachable, serve the request rather than failing it with a 500.
  skipOnError: true,
  keyGenerator: (req) => req.ip
});

app.register(require('@fastify/multipart'));
app.register(require('fastify-raw-body'), {
  field: 'rawBody',
  global: false,
  encoding: false,
  runFirst: true,
});

app.register(require('@fastify/static'), {
  root: path.join(__dirname, 'frontend'),
  prefix: '/',
  decorateReply: false
});

async function persistRefreshTokenSession({ jti, userId, role }) {
  const key = `refresh:${jti}`;
  await kv.setex(key, refreshTokenTtlSeconds, JSON.stringify({
    user_id: userId,
    role,
    created_at: new Date().toISOString(),
  }));
}

async function revokeRefreshTokenSession(jti) {
  await kv.del(`refresh:${jti}`);
}

async function issueAuthTokens(user) {
  const accessJti = uuidv4();
  const refreshJti = uuidv4();
  const token = app.jwt.sign({ id: user.id, role: user.role, jti: accessJti });
  const refreshToken = app.jwt.sign(
    { id: user.id, type: 'refresh', jti: refreshJti },
    { expiresIn: config.jwt.refreshExpiresIn }
  );
  await persistRefreshTokenSession({ jti: refreshJti, userId: user.id, role: user.role });
  return { token, refreshToken, accessJti, refreshJti };
}

function requestBodyHash(body) {
  const serialized = JSON.stringify(body ?? {});
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function getIdempotencyContext(req) {
  const keyHeader = req.headers['idempotency-key'];
  if (!keyHeader || Array.isArray(keyHeader)) return null;
  const key = String(keyHeader).trim();
  if (!key) return null;

  const actorId = req.user?.id || req.ip || 'anonymous';
  const routePath = req.routeOptions?.url || req.url.split('?')[0];
  const requestHash = requestBodyHash(req.body);
  const redisKey = `idem:${actorId}:${req.method}:${routePath}:${key}`;

  return {
    key,
    requestHash,
    redisKey,
  };
}

async function replayCachedIdempotentResponse(req, reply, cachedPayload) {
  let cached;
  try {
    cached = JSON.parse(cachedPayload);
  } catch {
    return false;
  }

  const context = req.idempotency;
  if (!context) return false;

  if (cached.request_hash && cached.request_hash !== context.requestHash) {
    return reply.code(409).send({
      error: 'Idempotency key already used with different payload',
      request_id: req.requestId
    });
  }

  if (cached.state === 'processing') {
    return reply.code(409).send({
      error: 'A request with the same idempotency key is already in progress',
      request_id: req.requestId
    });
  }

  if (cached.state === 'completed') {
    req.idempotency.replayed = true;
    reply.header('x-idempotent-replay', 'true');
    const statusCode = cached.status_code || 200;
    return reply.code(statusCode).send(cached.body);
  }

  return false;
}

// ============================================================
// MIDDLEWARE
// ============================================================

// Authentication hook
const authenticate = async (req, reply) => {
  try {
    await req.jwtVerify();

    // Refresh tokens must only be exchanged at /auth/refresh, never used as access tokens.
    if (req.user.type === 'refresh') {
      metrics.authFailuresTotal += 1;
      return reply.code(401).send({ error: 'Authentication required' });
    }

    // Check if token is blacklisted (on logout)
    const blacklisted = await kv.get(`blacklist:${req.user.jti}`);
    if (blacklisted) {
      return reply.code(401).send({ error: 'Token revoked' });
    }
    
    // Load user from cache or DB
    const cacheKey = `user:${req.user.id}`;
    let user = await Cache.get(cacheKey);
    
    if (!user) {
      const { rows } = await query(
        'SELECT id, role, email, phone, first_name, last_name, is_active, is_banned FROM users WHERE id = $1',
        [req.user.id]
      );
      if (!rows[0]) return reply.code(401).send({ error: 'User not found' });
      user = rows[0];
      await Cache.set(cacheKey, user, 300);
    }
    
    if (!user.is_active || user.is_banned) {
      return reply.code(403).send({ error: 'Account suspended' });
    }
    
    req.user = { ...req.user, ...user };
  } catch (err) {
    metrics.authFailuresTotal += 1;
    return reply.code(401).send({ error: 'Authentication required' });
  }
};

const requireRole = (...roles) => async (req, reply) => {
  if (!roles.includes(req.user.role)) {
    return reply.code(403).send({ error: 'Insufficient permissions' });
  }
};

const requireDatabase = async (req, reply) => {
  if (!dbConnected) {
    return reply.code(503).send({ error: 'Database unavailable', request_id: req.requestId });
  }
};

// Operations endpoints (fleet, cold-chain, overview) require an ops/admin token unless
// OPS_AUTH_REQUIRED=false is set explicitly for local development.
const opsAuthRequired = getEnv('OPS_AUTH_REQUIRED', isProduction ? 'true' : 'false') === 'true';
const opsGuard = async (req, reply) => {
  if (!opsAuthRequired) return;
  const denied = await authenticate(req, reply);
  if (denied || reply.sent) return denied;
  return requireRole('admin', 'ops')(req, reply);
};

const idempotencyGuard = async (req, reply) => {
  const context = getIdempotencyContext(req);
  if (!context) return;

  req.idempotency = {
    ...context,
    ownsLock: false,
    replayed: false,
  };

  reply.header('x-idempotency-key', context.key);

  const existing = await kv.get(context.redisKey);
  if (existing) {
    return replayCachedIdempotentResponse(req, reply, existing);
  }

  const lockPayload = JSON.stringify({
    state: 'processing',
    request_hash: context.requestHash,
    created_at: new Date().toISOString(),
  });

  const lockSet = await kv.set(
    context.redisKey,
    lockPayload,
    'NX',
    'EX',
    idempotencyProcessingTtlSeconds
  );

  if (lockSet !== 'OK') {
    const raceValue = await kv.get(context.redisKey);
    if (raceValue) {
      return replayCachedIdempotentResponse(req, reply, raceValue);
    }
    return reply.code(409).send({
      error: 'Could not acquire idempotency lock',
      request_id: req.requestId
    });
  }

  req.idempotency.ownsLock = true;
};

// Request logger
app.addHook('onRequest', (req, reply, done) => {
  const incomingRequestId = req.headers['x-request-id'];
  req.requestId = typeof incomingRequestId === 'string' && incomingRequestId.trim()
    ? incomingRequestId
    : req.id;
  reply.header('x-request-id', req.requestId);
  req.startTime = Date.now();
  done();
});

app.addHook('onSend', async (req, reply, payload) => {
  const context = req.idempotency;
  if (!context || !context.ownsLock || context.replayed) return payload;

  // Do not cache server errors.
  if (reply.statusCode >= 500) {
    await kv.del(context.redisKey);
    return payload;
  }

  let responseBody = payload;
  if (Buffer.isBuffer(payload)) {
    responseBody = payload.toString('utf8');
  }
  if (typeof responseBody === 'string') {
    try {
      responseBody = JSON.parse(responseBody);
    } catch {
      // Keep raw string payload.
    }
  }

  await kv.setex(context.redisKey, idempotencyTtlSeconds, JSON.stringify({
    state: 'completed',
    request_hash: context.requestHash,
    status_code: reply.statusCode,
    body: responseBody,
    cached_at: new Date().toISOString(),
  }));

  return payload;
});

app.addHook('onError', async (req, reply, err) => {
  const context = req.idempotency;
  if (!context || !context.ownsLock || context.replayed) return;
  await kv.del(context.redisKey);
});

app.addHook('onResponse', (req, reply, done) => {
  const duration = Date.now() - req.startTime;
  metrics.requestsTotal += 1;
  metrics.requestDurationMsSum += duration;
  metrics.requestDurationMsCount += 1;
  incrementStatusCount(reply.statusCode);

  logger.info({
    requestId: req.requestId,
    method: req.method,
    url: req.url,
    statusCode: reply.statusCode,
    duration,
    ip: req.ip
  }, 'Request completed');
  done();
});

// ============================================================
// STRIPE
// ============================================================

const stripe = Stripe(config.stripe.secretKey);

// ============================================================
// AI ENGINE CLIENT
// ============================================================

const AI = {
  async dispatch(payload) {
    const { data } = await axios.post(`${config.ai.baseUrl}/dispatch`, payload, { timeout: 15000 });
    return data;
  },
  async price(payload) {
    try {
      const { data } = await axios.post(`${config.ai.baseUrl}/price`, payload, { timeout: 5000 });
      return data;
    } catch (err) {
      // AI engine unreachable: fall back to the published rate card so booking keeps working.
      logger.warn({ msg: err.message }, 'AI pricing unavailable; using local rate card');
      return localPrice(payload);
    }
  },
  async checkFraud(payload) {
    const { data } = await axios.post(`${config.ai.baseUrl}/fraud/check`, payload, { timeout: 3000 });
    return data;
  },
  async forecastDemand(zoneIds) {
    const { data } = await axios.post(`${config.ai.baseUrl}/demand/forecast`, zoneIds, { timeout: 10000 });
    return data;
  },
  async rebalanceFleet(payload) {
    try {
      const { data } = await axios.post(`${config.ai.baseUrl}/fleet/rebalance`, payload, { timeout: 5000 });
      return data;
    } catch {
      return null;
    }
  },
  async checkColdChain(payload) {
    try {
      const { data } = await axios.post(`${config.ai.baseUrl}/cold-chain/check`, payload, { timeout: 5000 });
      return data;
    } catch {
      return null;
    }
  }
};

// ------------------------------------------------------------
// Local rate card (fallback when the AI engine is unreachable)
// ------------------------------------------------------------

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const round2 = (n) => Number(Number(n).toFixed(2));

function localPrice(p) {
  // Straight-line distance understates road distance; 1.3 is a common urban detour factor.
  const km = Math.max(0.5, haversineKm(p.pickup_lat, p.pickup_lng, p.dropoff_lat, p.dropoff_lng) * 1.3);
  const minutes = (km / 30) * 60;
  const freight = ['freight', 'courier', 'cold_chain'].includes(p.service_type);
  let base = freight ? 5.0 : 2.5;
  let distanceFare = km * (freight ? 2.0 : 1.2);
  let timeFare = freight ? 0 : minutes * 0.25;
  if (freight) distanceFare += (p.cargo_weight_kg || 0) * 0.05;
  let total = base + distanceFare + timeFare;
  const coldSurcharge = (p.service_type === 'cold_chain' || p.requires_refrigeration) ? total * 0.35 : 0;
  total += coldSurcharge;
  if (!freight) total = Math.max(total, 5.0);
  total = round2(total);
  return {
    breakdown: {
      base_fare: round2(base),
      distance_fare: round2(distanceFare),
      time_fare: round2(timeFare),
      cold_chain_surcharge: round2(coldSurcharge),
    },
    surge_multiplier: 1.0,
    surge_reason: null,
    total_fare: total,
    estimated_range: [round2(total * 0.9), round2(total * 1.1)],
    currency: 'USD',
    source: 'local_rate_card',
  };
}

// ============================================================
// VALIDATION SCHEMAS
// ============================================================

const DUMMY_BCRYPT_HASH = bcrypt.hashSync('nexus-timing-equaliser', 10);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRIP_STATUSES = ['requested', 'searching', 'accepted', 'driver_en_route', 'arrived', 'in_progress', 'completed', 'cancelled', 'failed'];
const VEHICLE_TYPES = ['sedan', 'hatchback', 'suv', 'luxury', 'van', 'truck_small', 'truck_medium', 'truck_large', 'refrigerated', 'motorcycle', 'bicycle'];

const schemas = {
  register: z.object({
    email: z.string().email().transform((v) => v.toLowerCase()),
    phone: z.string().min(8).max(20),
    first_name: z.string().min(1).max(100),
    last_name: z.string().min(1).max(100),
    password: z.string().min(8).max(100),
    referral_code: z.string().optional(),
  }),
  
  login: z.object({
    email: z.string().email().transform((v) => v.toLowerCase()),
    password: z.string().min(1),
    device_id: z.string().optional(),
  }),

  refreshToken: z.object({
    refresh_token: z.string().min(16),
  }),

  registerDriver: z.object({
    email: z.string().email().transform((v) => v.toLowerCase()),
    phone: z.string().min(8).max(20),
    first_name: z.string().min(1).max(100),
    last_name: z.string().min(1).max(100),
    password: z.string().min(8).max(100),
    mode: z.enum(['ride', 'freight', 'both']).default('ride'),
    vehicle: z.object({
      plate_number: z.string().min(2).max(20),
      make: z.string().min(1).max(50),
      model: z.string().min(1).max(50),
      year: z.number().int().min(1990).max(new Date().getFullYear() + 1),
      color: z.string().min(1).max(30),
      vehicle_type: z.enum(VEHICLE_TYPES),
    }),
  }),

  driverLocation: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    heading: z.number().int().min(0).max(360).optional(),
    speed_kmh: z.number().min(0).max(400).optional(),
    accuracy_m: z.number().int().min(0).max(32000).optional(),
    battery_pct: z.number().int().min(0).max(100).optional(),
  }),

  driverStatus: z.object({ status: z.enum(['available', 'offline', 'on_break']) }),
  driverMode: z.object({ mode: z.enum(['ride', 'freight', 'both']) }),
  rating: z.object({ rating: z.number().int().min(1).max(5), review: z.string().max(1000).optional() }),
  
  requestRide: z.object({
    pickup_lat: z.number().min(-90).max(90),
    pickup_lng: z.number().min(-180).max(180),
    pickup_address: z.string().min(1),
    dropoff_lat: z.number().min(-90).max(90),
    dropoff_lng: z.number().min(-180).max(180),
    dropoff_address: z.string().min(1),
    service_type: z.enum(['taxi', 'freight', 'medical', 'airport', 'courier', 'cold_chain']).default('taxi'),
    vehicle_type: z.enum(VEHICLE_TYPES).optional(),
    payment_method: z.enum(['card', 'cash', 'wallet', 'corporate']).default('card'),
    passengers: z.number().int().min(1).max(8).default(1),
    scheduled_for: z.string().datetime().optional(),
    promo_code: z.string().optional(),
  }),
  
  requestDelivery: z.object({
    pickup_lat: z.number().min(-90).max(90),
    pickup_lng: z.number().min(-180).max(180),
    pickup_address: z.string().min(1),
    pickup_contact_name: z.string().min(1),
    pickup_contact_phone: z.string().min(1),
    dropoff_lat: z.number().min(-90).max(90),
    dropoff_lng: z.number().min(-180).max(180),
    dropoff_address: z.string().min(1),
    dropoff_contact_name: z.string().min(1),
    dropoff_contact_phone: z.string().min(1),
    cargo_description: z.string().min(1),
    cargo_weight_kg: z.number().positive(),
    cargo_length_cm: z.number().optional(),
    cargo_width_cm: z.number().optional(),
    cargo_height_cm: z.number().optional(),
    cargo_value: z.number().optional(),
    is_fragile: z.boolean().default(false),
    requires_refrigeration: z.boolean().default(false),
    temp_min_celsius: z.number().optional(),
    temp_max_celsius: z.number().optional(),
    insurance_requested: z.boolean().default(false),
    pickup_window_start: z.string().datetime().optional(),
    pickup_window_end: z.string().datetime().optional(),
  }),

  b2bQuote: z.object({
    pickup_lat: z.number().min(-90).max(90),
    pickup_lng: z.number().min(-180).max(180),
    dropoff_lat: z.number().min(-90).max(90),
    dropoff_lng: z.number().min(-180).max(180),
    cargo_weight_kg: z.number().positive().default(10),
    cargo_volume_m3: z.number().positive().optional().default(0.2),
    service_type: z.enum(['courier', 'standard_parcel', 'bulk_freight', 'cold_chain', 'oversized', 'express_same_day']).default('standard_parcel'),
    requires_refrigeration: z.boolean().default(false),
    cargo_value: z.number().optional().default(0),
    insurance_requested: z.boolean().default(false),
  }),

  // Signature arrives as a PNG data URL from the driver app's signature pad (~200 KB cap).
  proofOfDelivery: z.object({
    otp: z.union([z.string(), z.number()]).optional(),
    recipient_name: z.string().trim().min(1).max(100).optional(),
    pod_signature: z.string().max(200_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Signature must be a PNG data URL').optional(),
    pod_photo_url: z.string().url().max(2000).optional(),
  }).passthrough(),
  coldChainTelemetry: z.object({
    delivery_id: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/, 'delivery_id may contain letters, digits, - and _ only'),
    temperature_c: z.number().min(-100).max(100),
    humidity_pct: z.number().optional().default(60),
    battery_pct: z.number().optional().default(85),
    seal_intact: z.boolean().default(true),
    lat: z.number().optional().default(40.75),
    lng: z.number().optional().default(-73.98),
  }),
};

function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw { statusCode: 400, message: 'Validation failed', errors: result.error.flatten() };
  }
  return result.data;
}

// ============================================================
// ROUTES — OPS & HEALTH
// ============================================================

app.get('/health', async () => {
  return {
    status: 'ok',
    service: 'nexus-api',
    uptime_sec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
});

app.get('/api/v1/health', async () => {
  return {
    status: 'ok',
    service: 'nexus-api',
    uptime_sec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
});

const readinessHandler = async (req, reply) => {
  const checks = {
    database: 'down',
    redis: 'down',
  };

  let ready = true;

  try {
    await db.query('SELECT 1');   // direct: query() hides failures in dev demo mode
    checks.database = 'up';
  } catch (err) {
    ready = false;
    logger.error({ requestId: req.requestId, err }, 'Readiness DB check failed');
  }

  try {
    const pong = await redis.ping();
    checks.redis = pong === 'PONG' ? 'up' : 'degraded';
    if (pong !== 'PONG') ready = false;
  } catch (err) {
    ready = false;
    logger.error({ requestId: req.requestId, err }, 'Readiness Redis check failed');
  }

  const payload = {
    status: ready ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString(),
  };

  if (!ready) return reply.code(503).send(payload);
  return reply.send(payload);
};

app.get('/ready', readinessHandler);
app.get('/api/v1/ready', readinessHandler);

const metricsHandler = async (req, reply) => {
  reply.type('text/plain; version=0.0.4; charset=utf-8');
  return reply.send(formatPrometheusMetrics());
};

app.get('/metrics', metricsHandler);
app.get('/api/v1/metrics', metricsHandler);

// ============================================================
// ROUTES — AUTHENTICATION
// ============================================================

app.post('/api/v1/auth/register', { preHandler: requireDatabase, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
  const body = validate(schemas.register, req.body);
  
  // Check if email/phone exists
  const { rows: existing } = await query(
    'SELECT id FROM users WHERE email = $1 OR phone = $2',
    [body.email, body.phone]
  );
  if (existing.length > 0) {
    return reply.code(409).send({ error: 'Email or phone already registered' });
  }
  
  // Hash password
  const salt = await bcrypt.genSalt(config.app.bcryptRounds);
  const passwordHash = await bcrypt.hash(body.password, salt);
  
  // Handle referral
  let referredById = null;
  if (body.referral_code) {
    const { rows: referrer } = await query(
      'SELECT id FROM users WHERE referral_code = $1',
      [body.referral_code]
    );
    if (referrer.length > 0) referredById = referrer[0].id;
  }
  
  // Generate unique referral code for new user
  const newReferralCode = `NX${Date.now().toString(36).toUpperCase()}${randomDigits(2)}`;

  let user;
  try {
    ({ rows: [user] } = await query(`
      INSERT INTO users (email, phone, first_name, last_name, password_hash, salt, referral_code, referred_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, email, phone, first_name, last_name, role, referral_code, created_at
    `, [body.email, body.phone, body.first_name, body.last_name, passwordHash, salt, newReferralCode, referredById]));
  } catch (err) {
    if (err.code === '23505') return reply.code(409).send({ error: 'Email or phone already registered' });   // lost a registration race
    throw err;
  }
  
  // Issue JWT + refresh token session
  const { token, refreshToken } = await issueAuthTokens(user);
  
  // Award referral points
  if (referredById) {
    await query('UPDATE users SET nexus_points = nexus_points + 100 WHERE id = $1', [referredById]);
  }
  
  logger.info({ userId: user.id, email: user.email }, 'New user registered');
  
  return reply.code(201).send({
    user: {
      id: user.id,
      email: user.email,
      phone: user.phone,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      referral_code: user.referral_code,
    },
    token,
    refresh_token: refreshToken,
  });
});


app.post('/api/v1/auth/login', { preHandler: requireDatabase, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
  const body = validate(schemas.login, req.body);
  
  // Check lockout
  const lockKey = `lockout:${body.email}`;
  const attempts = await Cache.get(lockKey);
  if (Number(attempts) >= config.app.maxLoginAttempts) {
    return reply.code(429).send({ error: 'Account temporarily locked due to failed login attempts. Try again later.' });
  }
  
  const { rows: [user] } = await query(
    'SELECT id, email, phone, first_name, last_name, role, password_hash, is_active, is_banned FROM users WHERE email = $1',
    [body.email]
  );
  
  // Always run a bcrypt compare so response time does not reveal whether the email exists.
  const passwordOk = await bcrypt.compare(body.password, user ? user.password_hash : DUMMY_BCRYPT_HASH);
  if (!user || !passwordOk) {
    // Increment failure counter
    await Cache.incr(lockKey, config.app.loginLockoutMinutes * 60);
    return reply.code(401).send({ error: 'Invalid email or password' });
  }
  
  if (!user.is_active) return reply.code(403).send({ error: 'Account deactivated' });
  if (user.is_banned) return reply.code(403).send({ error: 'Account suspended. Contact support.' });
  
  // Clear lockout
  await Cache.del(lockKey);

  // Update last login
  await query('UPDATE users SET last_login_at = NOW(), last_login_ip = $1 WHERE id = $2', [req.ip, user.id]);
  
  const { token, refreshToken } = await issueAuthTokens(user);
  
  return reply.send({
    user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role },
    token,
    refresh_token: refreshToken,
  });
});


app.post('/api/v1/auth/logout', { preHandler: authenticate }, async (req, reply) => {
  // Blacklist current token
  await kv.setex(`blacklist:${req.user.jti}`, accessTokenTtlSeconds, '1');

  // Optional: revoke refresh token session if provided.
  const refreshToken = req.body?.refresh_token;
  if (refreshToken && typeof refreshToken === 'string') {
    try {
      const decoded = app.jwt.verify(refreshToken);
      if (decoded?.type === 'refresh' && decoded?.id === req.user.id && decoded?.jti) {
        await revokeRefreshTokenSession(decoded.jti);
      }
    } catch {
      // Ignore invalid refresh token on logout.
    }
  }

  return reply.send({ message: 'Logged out successfully' });
});

app.post('/api/v1/auth/refresh', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
  const body = validate(schemas.refreshToken, req.body);

  let decoded;
  try {
    decoded = app.jwt.verify(body.refresh_token);
  } catch {
    return reply.code(401).send({ error: 'Invalid refresh token' });
  }

  if (decoded?.type !== 'refresh' || !decoded?.id || !decoded?.jti) {
    return reply.code(401).send({ error: 'Invalid refresh token' });
  }

  const refreshKey = `refresh:${decoded.jti}`;
  const storedSessionRaw = await kv.get(refreshKey);
  if (!storedSessionRaw) {
    return reply.code(401).send({ error: 'Refresh token expired or revoked' });
  }

  let storedSession;
  try {
    storedSession = JSON.parse(storedSessionRaw);
  } catch {
    await kv.del(refreshKey);
    return reply.code(401).send({ error: 'Refresh session invalid' });
  }

  if (storedSession.user_id !== decoded.id) {
    await kv.del(refreshKey);
    return reply.code(401).send({ error: 'Refresh token does not match session' });
  }

  const { rows: [user] } = await query(
    'SELECT id, role, email, first_name, last_name, is_active, is_banned FROM users WHERE id = $1',
    [decoded.id]
  );

  if (!user) {
    await kv.del(refreshKey);
    return reply.code(401).send({ error: 'User not found' });
  }
  if (!user.is_active || user.is_banned) {
    await kv.del(refreshKey);
    return reply.code(403).send({ error: 'Account suspended' });
  }

  // Rotate refresh token to prevent replay.
  await revokeRefreshTokenSession(decoded.jti);
  const { token, refreshToken } = await issueAuthTokens(user);

  return reply.send({
    token,
    refresh_token: refreshToken,
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
    }
  });
});

// ============================================================
// ROUTES — TRIPS (TAXI)
// ============================================================
//
// Trip lifecycle (state machine, enforced with atomic UPDATE ... WHERE status = ...):
//
//   requested -> searching -> accepted (offered to a driver, awaiting confirmation)
//     -> driver_en_route -> arrived -> in_progress -> completed
//   Any pre-pickup state can move to cancelled; an unassignable request ends as failed.

const PLATFORM_FEE_RATE = 0.20;
const dispatchTimeoutMs = Number(getEnv('DISPATCH_TIMEOUT_SEC', config.app.dispatchTimeoutSec)) * 1000;
const driverResponseTimeoutMs = Number(getEnv('DRIVER_RESPONSE_TIMEOUT_SEC', 20)) * 1000;
const sweepIntervalMs = Number(getEnv('DISPATCH_SWEEP_MS', 3000));

const SERVICE_BY_MODE = {
  ride: ['taxi', 'airport', 'medical'],
  freight: ['freight', 'courier', 'cold_chain'],
  both: ['taxi', 'airport', 'medical', 'freight', 'courier', 'cold_chain'],
};

function modeFromServiceTypes(serviceTypes = []) {
  const ride = serviceTypes.some((t) => SERVICE_BY_MODE.ride.includes(t));
  const freight = serviceTypes.some((t) => SERVICE_BY_MODE.freight.includes(t));
  if (ride && freight) return 'both';
  return freight ? 'freight' : 'ride';
}

function randomDigits(n) {
  return String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
}

async function getDriverByUserId(userId) {
  const { rows } = await query(
    `SELECT id, user_id, status, is_online, onboarding_completed, service_types::text[] AS service_types FROM drivers WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

const requireDriver = async (req, reply) => {
  if (req.user.role !== 'driver') return reply.code(403).send({ error: 'Driver only' });
  const driver = await getDriverByUserId(req.user.id);
  if (!driver) return reply.code(403).send({ error: 'Driver profile not found' });
  req.driver = driver;
};

async function listNearbyDrivers({ lat, lng, serviceType, excludeDriverIds = [] }) {
  const { rows } = await query(`
    SELECT d.id, d.user_id, d.rating_overall AS rating, d.acceptance_rate, d.completion_rate,
           d.service_types::text[] AS service_types, d.total_trips,
           ST_Y(d.current_location::geometry) AS lat,
           ST_X(d.current_location::geometry) AS lng,
           ST_Distance(d.current_location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_m,
           v.vehicle_type
    FROM drivers d
    LEFT JOIN LATERAL (
      SELECT vehicle_type FROM vehicles WHERE driver_id = d.id AND is_active ORDER BY created_at LIMIT 1
    ) v ON TRUE
    WHERE d.is_online AND d.status = 'available' AND d.onboarding_completed
      AND d.current_location IS NOT NULL
      AND d.location_updated_at > NOW() - INTERVAL '2 minutes'
      AND $3::service_type = ANY(d.service_types)
      AND NOT (d.id = ANY($4::uuid[]))
      AND ST_DWithin(d.current_location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $5)
    ORDER BY distance_m
    LIMIT 25
  `, [lat, lng, serviceType, excludeDriverIds, config.app.driverSearchRadiusKm * 1000]);
  return rows.map((r) => ({
    ...r,
    lat: Number(r.lat),
    lng: Number(r.lng),
    distance_m: Number(r.distance_m),
    rating: Number(r.rating) || 4.5,
    acceptance_rate: Number(r.acceptance_rate),
    completion_rate: Number(r.completion_rate),
  }));
}

// Atomically reserve a driver so two jobs can never be offered to the same person.
async function reserveDriver(driverId) {
  const { rowCount } = await query(
    "UPDATE drivers SET status = 'on_trip' WHERE id = $1 AND status = 'available' AND is_online",
    [driverId]
  );
  return rowCount === 1;
}

async function releaseDriver(driverId) {
  if (!driverId) return;
  await query("UPDATE drivers SET status = 'available' WHERE id = $1 AND status = 'on_trip' AND is_online", [driverId]);
}

async function getDeclined(kind, id) {
  const raw = await kv.get(`declined:${kind}:${id}`);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

async function addDeclined(kind, id, driverId) {
  const list = await getDeclined(kind, id);
  if (!list.includes(driverId)) list.push(driverId);
  await kv.setex(`declined:${kind}:${id}`, 3600, JSON.stringify(list));
}

// Rank candidates with the AI engine; fall back to nearest-first if it is unreachable.
async function rankCandidates(request, candidates) {
  let order = candidates.map((c) => c.id);
  let meta = { ai_score: null, eta_pickup_min: null, eta_dropoff_min: null, alternatives_considered: candidates.length };
  try {
    const decision = await AI.dispatch({ ...request, drivers: candidates });
    if (decision?.driver_id && order.includes(decision.driver_id)) {
      order = [decision.driver_id, ...order.filter((id) => id !== decision.driver_id)];
      meta = {
        ai_score: decision.ai_score ?? null,
        eta_pickup_min: decision.eta_pickup_min ?? null,
        eta_dropoff_min: decision.eta_dropoff_min ?? null,
        alternatives_considered: decision.alternatives_considered ?? candidates.length,
      };
    }
  } catch (err) {
    logger.warn({ msg: err.message }, 'AI dispatch unavailable; using nearest-driver ranking');
  }
  if (meta.eta_pickup_min === null) {
    const first = candidates.find((c) => c.id === order[0]);
    meta.eta_pickup_min = Number(((first.distance_m / 1000) / 30 * 60 + 1).toFixed(1));
  }
  return { order, meta };
}

async function dispatchTrip(tripId) {
  const { rows: [trip] } = await query('SELECT * FROM trips WHERE id = $1', [tripId]);
  if (!trip || !['requested', 'searching'].includes(trip.status)) return;

  const waitedMs = Date.now() - new Date(trip.requested_at).getTime();
  const declined = await getDeclined('trip', trip.id);
  const candidates = await listNearbyDrivers({
    lat: Number(trip.pickup_lat),
    lng: Number(trip.pickup_lng),
    serviceType: trip.service_type,
    excludeDriverIds: declined,
  });

  if (trip.status === 'requested') {
    await query("UPDATE trips SET status = 'searching' WHERE id = $1 AND status = 'requested'", [trip.id]);
  }

  if (candidates.length === 0) {
    if (waitedMs >= dispatchTimeoutMs) {
      const { rowCount } = await query(
        "UPDATE trips SET status = 'failed', cancelled_by = 'system', cancellation_reason = 'No driver available' WHERE id = $1 AND status IN ('requested','searching')",
        [trip.id]
      );
      if (rowCount) io.to(`user:${trip.customer_id}`).emit('trip:dispatch_failed', { trip_id: trip.id, reason: 'no_driver_available' });
    }
    return;
  }

  const { order, meta } = await rankCandidates({
    request_id: trip.id,
    customer_id: trip.customer_id,
    pickup_lat: Number(trip.pickup_lat),
    pickup_lng: Number(trip.pickup_lng),
    pickup_address: trip.pickup_address,
    dropoff_lat: Number(trip.dropoff_lat),
    dropoff_lng: Number(trip.dropoff_lng),
    dropoff_address: trip.dropoff_address,
    service_type: trip.service_type,
    passengers: trip.passengers || 1,
  }, candidates);

  for (const driverId of order) {
    if (!(await reserveDriver(driverId))) continue;
    const { rows: [offered] } = await query(`
      UPDATE trips SET driver_id = $1, status = 'accepted', driver_assigned_at = NOW(),
        initial_eta_pickup_min = $2, initial_eta_dropoff_min = $3,
        dispatch_ai_score = $4, dispatch_alternatives = $5
      WHERE id = $6 AND status = 'searching'
      RETURNING id
    `, [driverId, meta.eta_pickup_min, meta.eta_dropoff_min, meta.ai_score, meta.alternatives_considered, trip.id]);

    if (!offered) {            // cancelled while we were matching
      await releaseDriver(driverId);
      return;
    }

    const driver = candidates.find((c) => c.id === driverId);
    io.to(`driver:${driverId}`).emit('trip:new_request', {
      trip_id: trip.id,
      pickup_address: trip.pickup_address,
      dropoff_address: trip.dropoff_address,
      estimated_earnings: Number((Number(trip.total_fare) * (1 - PLATFORM_FEE_RATE)).toFixed(2)),
      eta_pickup_min: meta.eta_pickup_min,
      respond_within_sec: driverResponseTimeoutMs / 1000,
    });
    io.to(`user:${trip.customer_id}`).emit('trip:driver_offered', { trip_id: trip.id, eta_pickup_min: meta.eta_pickup_min });
    logger.info({ tripId: trip.id, driverId, distance_m: driver?.distance_m }, 'Trip offered to driver');
    return;
  }
}

async function failOrRedispatchTrip(trip, reason) {
  await releaseDriver(trip.driver_id);
  if (trip.driver_id) await addDeclined('trip', trip.id, trip.driver_id);
  await query(`
    UPDATE trips SET status = 'searching', driver_id = NULL, driver_assigned_at = NULL
    WHERE id = $1 AND status = 'accepted' AND driver_id = $2
  `, [trip.id, trip.driver_id]);
  io.to(`user:${trip.customer_id}`).emit('trip:searching', { trip_id: trip.id, reason });
  await dispatchTrip(trip.id);
}

// Driver-side transitions. Each is a single guarded UPDATE so concurrent or replayed calls are safe.
async function driverTripAction(driver, tripId, action, body = {}) {
  const { rows: [trip] } = await query('SELECT * FROM trips WHERE id = $1 AND driver_id = $2', [tripId, driver.id]);
  if (!trip) return { code: 404, body: { error: 'Trip not found' } };

  const bad = (msg) => ({ code: 409, body: { error: msg || `Cannot ${action} a trip in '${trip.status}' status` } });

  if (action === 'decline') {
    if (trip.status !== 'accepted') return bad();
    await failOrRedispatchTrip(trip, 'driver_declined');
    return { code: 200, body: { message: 'Trip declined' } };
  }

  if (action === 'accept') {
    if (trip.status !== 'accepted') return bad();
    await query("UPDATE trips SET status = 'driver_en_route' WHERE id = $1 AND status = 'accepted'", [trip.id]);
    io.to(`user:${trip.customer_id}`).emit('trip:driver_en_route', { trip_id: trip.id, driver_id: driver.id });
    return { code: 200, body: { message: 'Trip accepted', status: 'driver_en_route' } };
  }

  if (action === 'arrive') {
    if (trip.status !== 'driver_en_route') return bad();
    await query("UPDATE trips SET status = 'arrived', driver_arrived_at = NOW() WHERE id = $1 AND status = 'driver_en_route'", [trip.id]);
    io.to(`user:${trip.customer_id}`).emit('trip:driver_arrived', { trip_id: trip.id });
    return { code: 200, body: { message: 'Arrival recorded', status: 'arrived' } };
  }

  if (action === 'start') {
    if (trip.status !== 'arrived') return bad();
    if (!body.otp || String(body.otp) !== String(trip.pickup_otp).trim()) {
      return { code: 403, body: { error: 'Invalid rider OTP' } };
    }
    await query("UPDATE trips SET status = 'in_progress', trip_started_at = NOW() WHERE id = $1 AND status = 'arrived'", [trip.id]);
    io.to(`user:${trip.customer_id}`).emit('trip:started', { trip_id: trip.id });
    return { code: 200, body: { message: 'Trip started', status: 'in_progress' } };
  }

  if (action === 'complete') {
    if (trip.status !== 'in_progress') return bad();
    const fare = Number(trip.total_fare) + Number(trip.tips || 0);
    const platformFee = Number((fare * PLATFORM_FEE_RATE).toFixed(2));
    const driverEarnings = Number((fare - platformFee).toFixed(2));
    const distanceKm = Number.isFinite(Number(body.actual_distance_km))
      ? Number(body.actual_distance_km)
      : Number(haversineKm(trip.pickup_lat, trip.pickup_lng, trip.dropoff_lat, trip.dropoff_lng).toFixed(3));

    const result = await transaction(async (client) => {
      const { rowCount } = await client.query(`
        UPDATE trips SET status = 'completed', trip_completed_at = NOW(), actual_distance_km = $1,
          platform_fee = $2, driver_earnings = $3,
          payment_status = CASE WHEN payment_method = 'cash' THEN 'captured'::payment_status ELSE payment_status END
        WHERE id = $4 AND status = 'in_progress'
      `, [distanceKm, platformFee, driverEarnings, trip.id]);
      if (rowCount !== 1) return null;
      await client.query(`
        UPDATE drivers SET total_trips = total_trips + 1, completed_trips = completed_trips + 1,
          total_km_driven = total_km_driven + $1, total_earnings = total_earnings + $2,
          pending_payout = pending_payout + $2, status = 'available'
        WHERE id = $3
      `, [distanceKm, driverEarnings, driver.id]);
      await client.query(`
        INSERT INTO payments (payment_ref, trip_id, customer_id, amount, currency, method, status, gateway, captured_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        `PAY-${trip.trip_number}`, trip.id, trip.customer_id, fare, trip.currency || 'USD',
        trip.payment_method || 'card',
        trip.payment_method === 'cash' ? 'captured' : 'pending',
        trip.payment_method === 'cash' ? 'cash' : 'stripe',
        trip.payment_method === 'cash' ? new Date() : null,
      ]);
      return true;
    });
    if (!result) return bad();
    io.to(`user:${trip.customer_id}`).emit('trip:completed', { trip_id: trip.id, total_fare: fare, request_rating: true });
    return { code: 200, body: { message: 'Trip completed', status: 'completed', fare, platform_fee: platformFee, driver_earnings: driverEarnings } };
  }

  return { code: 400, body: { error: 'Unknown action' } };
}

app.post('/api/v1/trips/estimate', async (req, reply) => {
  const body = validate(schemas.requestRide, req.body);

  const pricing = await AI.price({
    pickup_lat: body.pickup_lat,
    pickup_lng: body.pickup_lng,
    dropoff_lat: body.dropoff_lat,
    dropoff_lng: body.dropoff_lng,
    service_type: body.service_type,
  });

  return reply.send({
    price_estimate: pricing,
    currency: 'USD',
  });
});


// Create trip request
app.post('/api/v1/trips', { preHandler: [authenticate, requireDatabase, idempotencyGuard] }, async (req, reply) => {
  const body = validate(schemas.requestRide, req.body);
  const customerId = req.user.id;
  const tripId = uuidv4();
  const tripNumber = `TRP-${Date.now()}-${randomDigits(3)}`;

  // Only one open trip per rider
  const { rows: open } = await query(
    "SELECT id FROM trips WHERE customer_id = $1 AND status IN ('requested','searching','accepted','driver_en_route','arrived','in_progress') LIMIT 1",
    [customerId]
  );
  if (open.length) {
    return reply.code(409).send({ error: 'You already have an active trip', trip_id: open[0].id });
  }

  const pricing = await AI.price({
    pickup_lat: body.pickup_lat,
    pickup_lng: body.pickup_lng,
    dropoff_lat: body.dropoff_lat,
    dropoff_lng: body.dropoff_lng,
    service_type: body.service_type,
  });
  const pickupOtp = randomDigits(4);

  const { rows: [trip] } = await query(`
    INSERT INTO trips (
      id, trip_number, customer_id, service_type, vehicle_type_requested,
      pickup_lat, pickup_lng, pickup_address,
      dropoff_lat, dropoff_lng, dropoff_address,
      passengers, scheduled_for,
      base_fare, distance_fare, time_fare, surge_multiplier, total_fare, estimated_fare,
      currency, status, platform, payment_method, pickup_otp
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
    RETURNING *
  `, [
    tripId, tripNumber, customerId, body.service_type, body.vehicle_type || null,
    body.pickup_lat, body.pickup_lng, body.pickup_address,
    body.dropoff_lat, body.dropoff_lng, body.dropoff_address,
    body.passengers, body.scheduled_for || null,
    pricing.breakdown?.base_fare, pricing.breakdown?.distance_fare, pricing.breakdown?.time_fare,
    pricing.surge_multiplier, pricing.total_fare, pricing.total_fare,
    'USD', 'requested', req.headers['x-platform'] || 'web', body.payment_method, pickupOtp
  ]);

  // Match a driver in the background; the sweeper keeps retrying until the dispatch timeout.
  if (!trip.scheduled_for || new Date(trip.scheduled_for).getTime() - Date.now() < 10 * 60 * 1000) {
    dispatchTrip(trip.id).catch((err) => logger.error({ err, tripId: trip.id }, 'Dispatch failed'));
  }

  io.to(`user:${customerId}`).emit('trip:created', { trip_id: tripId, status: 'searching' });
  logger.info({ tripId, customerId }, 'Trip request created');

  return reply.code(201).send({
    trip: {
      id: trip.id,
      trip_number: trip.trip_number,
      status: trip.status,
      estimated_fare: pricing.total_fare,
      estimated_fare_range: pricing.estimated_range,
      surge_multiplier: pricing.surge_multiplier,
      surge_reason: pricing.surge_reason,
      pickup_otp: pickupOtp,
    },
    message: 'Searching for your driver...'
  });
});


// Get trip details
app.get('/api/v1/trips/:tripId', { preHandler: [authenticate, requireDatabase] }, async (req, reply) => {
  if (!UUID_RE.test(req.params.tripId)) return reply.code(404).send({ error: 'Trip not found' });
  const { rows: [trip] } = await query(`
    SELECT t.*,
      u.first_name || ' ' || u.last_name as driver_name,
      u.phone as driver_phone,
      u.avatar_url as driver_avatar,
      d.rating_overall as driver_rating,
      ST_Y(d.current_location::geometry) as driver_lat,
      ST_X(d.current_location::geometry) as driver_lng,
      v.make, v.model, v.color, v.plate_number
    FROM trips t
    LEFT JOIN drivers d ON t.driver_id = d.id
    LEFT JOIN users u ON d.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT make, model, color, plate_number FROM vehicles WHERE driver_id = d.id AND is_active ORDER BY created_at LIMIT 1
    ) v ON TRUE
    WHERE t.id = $1 AND (t.customer_id = $2 OR t.driver_id IN (
      SELECT id FROM drivers WHERE user_id = $2
    ) OR $3 IN ('admin', 'ops'))
  `, [req.params.tripId, req.user.id, req.user.role]);

  if (!trip) return reply.code(404).send({ error: 'Trip not found' });

  // The pickup OTP belongs to the rider; never reveal it to the driver or ops.
  if (trip.customer_id !== req.user.id) delete trip.pickup_otp;
  return reply.send({ trip });
});


// Cancel trip
app.post('/api/v1/trips/:tripId/cancel', { preHandler: [authenticate, requireDatabase] }, async (req, reply) => {
  if (!UUID_RE.test(req.params.tripId)) return reply.code(404).send({ error: 'Trip not found' });
  const { rows: [trip] } = await query(
    'SELECT * FROM trips WHERE id = $1 AND customer_id = $2',
    [req.params.tripId, req.user.id]
  );

  if (!trip) return reply.code(404).send({ error: 'Trip not found' });

  const cancellableStatuses = ['requested', 'searching', 'accepted', 'driver_en_route', 'arrived'];
  if (!cancellableStatuses.includes(trip.status)) {
    return reply.code(400).send({ error: `Cannot cancel trip in '${trip.status}' status` });
  }

  const cancellationFee = ['driver_en_route', 'arrived'].includes(trip.status) ? 3.00 : 0;

  const { rowCount } = await query(`
    UPDATE trips SET
      status = 'cancelled',
      trip_cancelled_at = NOW(),
      cancelled_by = 'customer',
      cancellation_reason = $1
    WHERE id = $2 AND status = $3
  `, [String(req.body?.reason || 'Customer cancelled').slice(0, 500), trip.id, trip.status]);
  if (rowCount !== 1) return reply.code(409).send({ error: 'Trip status changed; please retry' });

  if (trip.driver_id) {
    io.to(`driver:${trip.driver_id}`).emit('trip:cancelled', { trip_id: trip.id });
    await releaseDriver(trip.driver_id);
    await query('UPDATE drivers SET cancelled_trips = cancelled_trips + 1 WHERE id = $1', [trip.driver_id]);
  }

  return reply.send({
    message: 'Trip cancelled',
    cancellation_fee: cancellationFee
  });
});


// Rate a completed trip
app.post('/api/v1/trips/:tripId/rate', { preHandler: [authenticate, requireDatabase] }, async (req, reply) => {
  if (!UUID_RE.test(req.params.tripId)) return reply.code(404).send({ error: 'Trip not found' });
  const { rating, review } = validate(schemas.rating, req.body);

  const { rows: [trip] } = await query(
    "SELECT * FROM trips WHERE id = $1 AND customer_id = $2 AND status = 'completed' AND customer_rating IS NULL",
    [req.params.tripId, req.user.id]
  );

  if (!trip) return reply.code(404).send({ error: 'Trip not found or already rated' });

  await query(`
    UPDATE trips SET
      customer_rating = $1,
      customer_review = $2,
      rated_at = NOW()
    WHERE id = $3
  `, [rating, review || null, trip.id]);

  return reply.send({ message: 'Rating submitted. Thank you!' });
});


// Get my trips
app.get('/api/v1/trips', { preHandler: [authenticate, requireDatabase] }, async (req, reply) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const { status } = req.query;
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE t.customer_id = $1';
  const params = [req.user.id];

  if (status) {
    if (!TRIP_STATUSES.includes(status)) return reply.code(400).send({ error: 'Invalid status filter' });
    params.push(status);
    whereClause += ` AND t.status = $${params.length}::trip_status`;
  }

  const { rows: trips } = await query(`
    SELECT t.id, t.trip_number, t.status, t.pickup_address, t.dropoff_address,
           t.total_fare, t.currency, t.customer_rating, t.created_at,
           t.trip_started_at, t.trip_completed_at, t.actual_distance_km,
           u.first_name || ' ' || u.last_name as driver_name,
           v.make, v.model, v.color
    FROM trips t
    LEFT JOIN drivers d ON t.driver_id = d.id
    LEFT JOIN users u ON d.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT make, model, color FROM vehicles WHERE driver_id = d.id AND is_active ORDER BY created_at LIMIT 1
    ) v ON TRUE
    ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, limit, offset]);

  return reply.send({ trips, page, limit });
});

// ============================================================
// ROUTES — DELIVERIES (FREIGHT)
// ============================================================
//
// Delivery lifecycle:
//   pending (unassigned, or offered to a driver while driver_id is set)
//     -> pickup_scheduled (driver accepted) -> in_transit (pickup OTP verified)
//     -> delivered (drop-off OTP verified)

function deliveryServiceType(body) {
  if (body.requires_refrigeration) return 'cold_chain';
  return body.cargo_weight_kg <= 5 ? 'courier' : 'freight';
}

async function dispatchDelivery(deliveryId) {
  const { rows: [delivery] } = await query('SELECT * FROM deliveries WHERE id = $1', [deliveryId]);
  if (!delivery || delivery.status !== 'pending' || delivery.driver_id) return;

  const waitedMs = Date.now() - new Date(delivery.requested_at).getTime();
  const serviceType = deliveryServiceType({
    requires_refrigeration: delivery.requires_refrigeration,
    cargo_weight_kg: Number(delivery.cargo_weight_kg),
  });
  const declined = await getDeclined('delivery', delivery.id);
  const candidates = await listNearbyDrivers({
    lat: Number(delivery.pickup_lat),
    lng: Number(delivery.pickup_lng),
    serviceType,
    excludeDriverIds: declined,
  });

  if (candidates.length === 0) {
    if (waitedMs >= dispatchTimeoutMs * 4) {   // freight is less time-critical than a ride
      const { rowCount } = await query(
        "UPDATE deliveries SET status = 'cancelled', failed_reason = 'No driver available' WHERE id = $1 AND status = 'pending' AND driver_id IS NULL",
        [delivery.id]
      );
      if (rowCount) io.to(`user:${delivery.customer_id}`).emit('delivery:dispatch_failed', { delivery_id: delivery.id });
    }
    return;
  }

  const { order, meta } = await rankCandidates({
    request_id: delivery.id,
    customer_id: delivery.customer_id,
    pickup_lat: Number(delivery.pickup_lat),
    pickup_lng: Number(delivery.pickup_lng),
    pickup_address: delivery.pickup_address,
    dropoff_lat: Number(delivery.dropoff_lat),
    dropoff_lng: Number(delivery.dropoff_lng),
    dropoff_address: delivery.dropoff_address,
    service_type: serviceType,
    cargo_weight_kg: Number(delivery.cargo_weight_kg),
    requires_refrigeration: !!delivery.requires_refrigeration,
  }, candidates);

  for (const driverId of order) {
    if (!(await reserveDriver(driverId))) continue;
    const { rowCount } = await query(
      "UPDATE deliveries SET driver_id = $1 WHERE id = $2 AND status = 'pending' AND driver_id IS NULL",
      [driverId, delivery.id]
    );
    if (rowCount !== 1) {
      await releaseDriver(driverId);
      return;
    }
    io.to(`driver:${driverId}`).emit('delivery:new_request', {
      delivery_id: delivery.id,
      pickup_address: delivery.pickup_address,
      dropoff_address: delivery.dropoff_address,
      cargo_description: delivery.cargo_description,
      cargo_weight_kg: Number(delivery.cargo_weight_kg),
      estimated_earnings: Number((Number(delivery.total_fare) * (1 - PLATFORM_FEE_RATE)).toFixed(2)),
      respond_within_sec: driverResponseTimeoutMs / 1000,
    });
    logger.info({ deliveryId: delivery.id, driverId }, 'Delivery offered to driver');
    return;
  }
}

async function driverDeliveryAction(driver, deliveryId, action, body = {}) {
  const { rows: [d] } = await query('SELECT * FROM deliveries WHERE id = $1 AND driver_id = $2', [deliveryId, driver.id]);
  if (!d) return { code: 404, body: { error: 'Delivery not found' } };
  const bad = () => ({ code: 409, body: { error: `Cannot ${action} a delivery in '${d.status}' status` } });

  if (action === 'decline') {
    if (d.status !== 'pending') return bad();
    await addDeclined('delivery', d.id, driver.id);
    await releaseDriver(driver.id);
    await query("UPDATE deliveries SET driver_id = NULL WHERE id = $1 AND status = 'pending' AND driver_id = $2", [d.id, driver.id]);
    await dispatchDelivery(d.id);
    return { code: 200, body: { message: 'Delivery declined' } };
  }

  if (action === 'accept') {
    if (d.status !== 'pending') return bad();
    await query("UPDATE deliveries SET status = 'pickup_scheduled' WHERE id = $1 AND status = 'pending'", [d.id]);
    io.to(`user:${d.customer_id}`).emit('delivery:driver_assigned', { delivery_id: d.id });
    return { code: 200, body: { message: 'Delivery accepted', status: 'pickup_scheduled' } };
  }

  if (action === 'pickup') {
    if (d.status !== 'pickup_scheduled') return bad();
    if (!body.otp || String(body.otp) !== String(d.pickup_otp).trim()) return { code: 403, body: { error: 'Invalid pickup OTP' } };
    await query("UPDATE deliveries SET status = 'in_transit', picked_up_at = NOW() WHERE id = $1 AND status = 'pickup_scheduled'", [d.id]);
    io.to(`user:${d.customer_id}`).emit('delivery:picked_up', { delivery_id: d.id });
    return { code: 200, body: { message: 'Pickup confirmed', status: 'in_transit' } };
  }

  if (action === 'deliver') {
    if (!['in_transit', 'out_for_delivery'].includes(d.status)) return bad();
    if (!body.otp || String(body.otp) !== String(d.dropoff_otp).trim()) return { code: 403, body: { error: 'Invalid delivery OTP' } };
    const fare = Number(d.total_fare);
    const platformFee = Number((fare * PLATFORM_FEE_RATE).toFixed(2));
    const driverEarnings = Number((fare - platformFee).toFixed(2));

    const pod = schemas.proofOfDelivery.safeParse(body);
    if (!pod.success) return { code: 400, body: { error: 'Invalid proof of delivery', details: pod.error.issues.map(i => i.message) } };
    const podSignature = pod.data.pod_signature || null;
    const podPhotoUrl = pod.data.pod_photo_url || null;
    const podRecipientName = pod.data.recipient_name || d.dropoff_contact_name || 'Recipient';

    const ok = await transaction(async (client) => {
      const { rowCount } = await client.query(`
        UPDATE deliveries SET
          status = 'delivered',
          delivered_at = NOW(),
          platform_fee = $1,
          driver_earnings = $2,
          dropoff_signature_url = COALESCE($4, dropoff_signature_url),
          dropoff_photo_url = COALESCE($5, dropoff_photo_url),
          dropoff_recipient_name = $6
        WHERE id = $3 AND status IN ('in_transit','out_for_delivery')
      `, [platformFee, driverEarnings, d.id, podSignature, podPhotoUrl, podRecipientName]);
      if (rowCount !== 1) return false;
      await client.query(`
        UPDATE drivers SET total_trips = total_trips + 1, completed_trips = completed_trips + 1,
          total_earnings = total_earnings + $1, pending_payout = pending_payout + $1, status = 'available'
        WHERE id = $2
      `, [driverEarnings, driver.id]);
      return true;
    });
    if (!ok) return bad();
    io.to(`user:${d.customer_id}`).emit('delivery:delivered', {
      delivery_id: d.id,
      recipient_name: podRecipientName,
      has_signature: !!podSignature,
      has_photo: !!podPhotoUrl
    });
    return {
      code: 200,
      body: {
        message: 'Delivery completed with Proof-of-Delivery',
        status: 'delivered',
        driver_earnings: driverEarnings,
        pod: {
          recipient_name: podRecipientName,
          signature_captured: !!podSignature,
          photo_captured: !!podPhotoUrl,
          completed_at: new Date().toISOString()
        }
      }
    };
  }

  return { code: 400, body: { error: 'Unknown action' } };
}

app.post('/api/v1/deliveries', { preHandler: [authenticate, requireDatabase, idempotencyGuard] }, async (req, reply) => {
  const body = validate(schemas.requestDelivery, req.body);
  const deliveryId = uuidv4();
  const deliveryNumber = `DEL-${Date.now()}-${randomDigits(3)}`;

  // OTPs must be unguessable: use the CSPRNG and always produce exactly 6 digits.
  const pickupOtp = randomDigits(6);
  const dropoffOtp = randomDigits(6);

  // Unguessable public tracking slug
  const trackingSlug = crypto.randomBytes(12).toString('hex');

  // Calculate insurance premium
  let insurancePremium = 0;
  if (body.insurance_requested && body.cargo_value) {
    insurancePremium = Number((body.cargo_value * 0.015).toFixed(2)); // 1.5% of declared value
  }

  const serviceType = deliveryServiceType(body);
  const pricing = await AI.price({
    pickup_lat: body.pickup_lat,
    pickup_lng: body.pickup_lng,
    dropoff_lat: body.dropoff_lat,
    dropoff_lng: body.dropoff_lng,
    service_type: serviceType,
    cargo_weight_kg: body.cargo_weight_kg,
    requires_refrigeration: body.requires_refrigeration,
  });
  const totalFare = round2(Number(pricing.total_fare) + insurancePremium);

  const { rows: [delivery] } = await query(`
    INSERT INTO deliveries (
      id, delivery_number, customer_id,
      pickup_contact_name, pickup_contact_phone, pickup_lat, pickup_lng, pickup_address,
      pickup_window_start, pickup_window_end, pickup_otp,
      dropoff_contact_name, dropoff_contact_phone, dropoff_lat, dropoff_lng, dropoff_address,
      dropoff_otp, tracking_url,
      cargo_description, cargo_weight_kg, cargo_length_cm, cargo_width_cm, cargo_height_cm,
      cargo_value, is_fragile, requires_refrigeration, temp_min_celsius, temp_max_celsius,
      insurance_requested, insurance_premium,
      base_fare, distance_fare, cold_chain_surcharge,
      total_fare, currency, status
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
      $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36
    )
    RETURNING *
  `, [
    deliveryId, deliveryNumber, req.user.id,
    body.pickup_contact_name, body.pickup_contact_phone, body.pickup_lat, body.pickup_lng, body.pickup_address,
    body.pickup_window_start || null, body.pickup_window_end || null, pickupOtp,
    body.dropoff_contact_name, body.dropoff_contact_phone, body.dropoff_lat, body.dropoff_lng, body.dropoff_address,
    dropoffOtp, `https://track.nexuslogistics.ai/${trackingSlug}`,
    body.cargo_description, body.cargo_weight_kg, body.cargo_length_cm ?? null, body.cargo_width_cm ?? null, body.cargo_height_cm ?? null,
    body.cargo_value ?? null, body.is_fragile, body.requires_refrigeration, body.temp_min_celsius ?? null, body.temp_max_celsius ?? null,
    body.insurance_requested, insurancePremium,
    pricing.breakdown?.base_fare ?? null, pricing.breakdown?.distance_fare ?? null, pricing.breakdown?.cold_chain_surcharge ?? null,
    totalFare, 'USD', 'pending'
  ]);

  dispatchDelivery(delivery.id).catch((err) => logger.error({ err, deliveryId: delivery.id }, 'Delivery dispatch failed'));

  logger.info({ deliveryId, customerId: req.user.id }, 'Delivery request created');

  return reply.code(201).send({
    delivery: {
      id: delivery.id,
      delivery_number: delivery.delivery_number,
      status: delivery.status,
      tracking_url: delivery.tracking_url,
      total_fare: delivery.total_fare,
      insurance_premium: insurancePremium,
      pickup_otp: pickupOtp,     // Customer gives this to the driver at pickup
      dropoff_otp: dropoffOtp,   // Customer shares this with the receiver, who gives it to the driver
    },
    message: 'Delivery scheduled. Driver will be assigned shortly.'
  });
});


app.get('/api/v1/deliveries/:id', { preHandler: [authenticate, requireDatabase] }, async (req, reply) => {
  if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: 'Delivery not found' });
  const { rows: [d] } = await query(`
    SELECT dl.*, u.first_name || ' ' || u.last_name AS driver_name, u.phone AS driver_phone
    FROM deliveries dl
    LEFT JOIN drivers dr ON dl.driver_id = dr.id
    LEFT JOIN users u ON dr.user_id = u.id
    WHERE dl.id = $1 AND (dl.customer_id = $2
      OR dl.driver_id IN (SELECT id FROM drivers WHERE user_id = $2)
      OR $3 IN ('admin','ops'))
  `, [req.params.id, req.user.id, req.user.role]);
  if (!d) return reply.code(404).send({ error: 'Delivery not found' });
  if (d.customer_id !== req.user.id) { delete d.pickup_otp; delete d.dropoff_otp; }
  return reply.send({ delivery: d });
});

app.post('/api/v1/deliveries/:id/cancel', { preHandler: [authenticate, requireDatabase] }, async (req, reply) => {
  if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: 'Delivery not found' });
  const { rows: [d] } = await query('SELECT * FROM deliveries WHERE id = $1 AND customer_id = $2', [req.params.id, req.user.id]);
  if (!d) return reply.code(404).send({ error: 'Delivery not found' });
  if (!['pending', 'pickup_scheduled'].includes(d.status)) {
    return reply.code(400).send({ error: `Cannot cancel delivery in '${d.status}' status` });
  }
  const { rowCount } = await query(
    "UPDATE deliveries SET status = 'cancelled', failed_reason = $1 WHERE id = $2 AND status = $3",
    [String(req.body?.reason || 'Customer cancelled').slice(0, 500), d.id, d.status]
  );
  if (rowCount !== 1) return reply.code(409).send({ error: 'Delivery status changed; please retry' });
  if (d.driver_id) {
    await releaseDriver(d.driver_id);
    io.to(`driver:${d.driver_id}`).emit('delivery:cancelled', { delivery_id: d.id });
  }
  return reply.send({ message: 'Delivery cancelled' });
});

// Track delivery or trip (public endpoint)
// Public tracking. With a database, only the unguessable tracking slug works: delivery
// numbers are sequential and ids are internal. Without one, the demo shipments are
// reachable by their demo id so the page can be previewed.
const TRACK_SLUG_RE = /^[a-f0-9]{24}$/;

function demoTrackingRecord(id) {
  const mem = inMemoryStore.deliveries.find(d => d.id === id);
  if (!mem) return null;
  const cc = inMemoryStore.coldChainShipments.find(s => s.id === id);
  return {
    delivery_number: mem.id,
    status: mem.status,
    cargo_description: cc?.cargo || (mem.type === 'cold_chain' ? 'Temperature-sensitive cargo' : 'Commercial goods'),
    pickup_address: mem.from,
    dropoff_address: mem.to,
    pickup_lat: 40.7895, pickup_lng: -74.0565,
    dropoff_lat: 40.7397, dropoff_lng: -73.9754,
    current_lat: 40.7580, current_lng: -73.9855,
    current_temp_celsius: cc?.current_temp_c ?? mem.current_temp_c ?? null,
    temp_min_celsius: cc?.min_temp_c ?? null,
    temp_max_celsius: cc?.max_temp_c ?? null,
    temp_alerts_count: cc && cc.status !== 'NORMAL' ? 1 : 0,
    requires_refrigeration: mem.type === 'cold_chain',
    estimated_delivery_at: new Date(Date.now() + 28 * 60000).toISOString(),
    delivered_at: null,
    driver_first_name: mem.driver ? mem.driver.split(' ')[0] : null,
    make: null, model: mem.vehicle || null, plate_number: cc?.plate || null,
    progress_pct: mem.progress_pct ?? null,
    sensor_battery_pct: cc ? parseInt(cc.battery, 10) : null,
    is_demo: true,
  };
}

async function findTrackedDelivery(slug) {
  if (dbConnected) {
    if (!TRACK_SLUG_RE.test(slug)) return null;
    const { rows: [d] } = await query(`
      SELECT
        d.delivery_number, d.status, d.cargo_description,
        d.pickup_address, d.dropoff_address,
        d.pickup_lat, d.pickup_lng, d.dropoff_lat, d.dropoff_lng,
        d.current_lat, d.current_lng, d.current_temp_celsius,
        d.temp_min_celsius, d.temp_max_celsius, d.temp_alerts_count, d.requires_refrigeration,
        d.estimated_delivery_at, d.picked_up_at, d.delivered_at, d.created_at,
        (d.dropoff_signature_url IS NOT NULL) AS signature_captured,
        u.first_name as driver_first_name,
        v.make, v.model, v.plate_number
      FROM deliveries d
      LEFT JOIN drivers dr ON d.driver_id = dr.id
      LEFT JOIN users u ON dr.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT make, model, plate_number FROM vehicles WHERE driver_id = dr.id AND is_active ORDER BY created_at LIMIT 1
      ) v ON TRUE
      WHERE d.tracking_url = $1
    `, [`https://track.nexuslogistics.ai/${slug}`]);
    return d ? { ...d, is_demo: false } : null;
  }
  return demoTrackingRecord(slug);
}

// Temperature status from what telemetry actually records: the latest reading and how
// many readings fell outside the range. There is no reading history, so no time-based
// excursion budget or mean kinetic temperature is claimed.
function temperatureSummary(d) {
  if (!d.requires_refrigeration) return null;
  const min = d.temp_min_celsius != null ? Number(d.temp_min_celsius) : null;
  const max = d.temp_max_celsius != null ? Number(d.temp_max_celsius) : null;
  const current = d.current_temp_celsius != null ? Number(d.current_temp_celsius) : null;
  const excursions = Number(d.temp_alerts_count || 0);
  const inRange = current == null || min == null || max == null ? null : current >= min && current <= max;
  return {
    current_c: current,
    min_c: min,
    max_c: max,
    in_range: inRange,
    excursion_readings: excursions,
    status: current == null ? 'NO_DATA' : inRange === false ? 'OUT_OF_RANGE' : excursions > 0 ? 'RECOVERED' : 'IN_RANGE',
  };
}

app.get('/api/v1/track/:slug', async (req, reply) => {
  const delivery = await findTrackedDelivery(req.params.slug);
  if (!delivery) return reply.code(404).send({ error: 'Tracking not found' });
  return reply.send({ delivery: { ...delivery, temperature: temperatureSummary(delivery) } });
});

// Shareable tracking link: /track/<slug> serves the tracking page, which reads the slug from the path.
const trackPagePath = path.join(__dirname, 'frontend', 'track.html');
app.get('/track/:slug', async (req, reply) => {
  const html = await fs.promises.readFile(trackPagePath);
  return reply.type('text/html; charset=utf-8').send(html);
});

// ------------------------------------------------------------
// Dispatch sweeper: retries unmatched jobs, expires unanswered offers.
// A Redis lock keeps multiple API instances from sweeping at once.
// ------------------------------------------------------------
async function sweepDispatch() {
  if (!dbConnected) return;
  try {
    const gotLock = await kv.set('lock:dispatch-sweeper', '1', 'NX', 'EX', Math.max(2, Math.floor(sweepIntervalMs / 1000)));
    if (gotLock !== 'OK') return;

    // 1. Offers the driver never answered
    const { rows: stale } = await query(
      "SELECT * FROM trips WHERE status = 'accepted' AND driver_assigned_at < NOW() - ($1 * INTERVAL '1 millisecond')",
      [driverResponseTimeoutMs]
    );
    for (const trip of stale) await failOrRedispatchTrip(trip, 'driver_timeout');

    const { rows: staleDeliveries } = await query(
      "SELECT * FROM deliveries WHERE status = 'pending' AND driver_id IS NOT NULL AND updated_at < NOW() - ($1 * INTERVAL '1 millisecond')",
      [driverResponseTimeoutMs]
    );
    for (const d of staleDeliveries) {
      await addDeclined('delivery', d.id, d.driver_id);
      await releaseDriver(d.driver_id);
      await query("UPDATE deliveries SET driver_id = NULL WHERE id = $1 AND status = 'pending' AND driver_id = $2", [d.id, d.driver_id]);
    }

    // 2. Requests still waiting for a driver
    const { rows: waiting } = await query(`
      SELECT id FROM trips
      WHERE status IN ('requested','searching')
        AND (scheduled_for IS NULL OR scheduled_for < NOW() + INTERVAL '10 minutes')
      ORDER BY requested_at LIMIT 50
    `);
    for (const t of waiting) await dispatchTrip(t.id);

    const { rows: waitingDeliveries } = await query(
      "SELECT id FROM deliveries WHERE status = 'pending' AND driver_id IS NULL ORDER BY requested_at LIMIT 50"
    );
    for (const d of waitingDeliveries) await dispatchDelivery(d.id);
  } catch (err) {
    logger.error({ err }, 'Dispatch sweep failed');
  }
}

// ============================================================
// ROUTES — B2B FREIGHT & COLD CHAIN TELEMETRY
// ============================================================

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.max(0.5, Number((R * c).toFixed(2)));
}

// B2B Freight Instant Quote (Public / Corporate Portal)
app.post('/api/v1/b2b/quote', async (req, reply) => {
  const body = validate(schemas.b2bQuote, req.body);
  const distanceKm = calculateDistanceKm(body.pickup_lat, body.pickup_lng, body.dropoff_lat, body.dropoff_lng);

  let baseFare = 5.00;
  let perKm = 2.00;
  if (body.service_type === 'courier') {
    baseFare = 2.50;
    perKm = 1.20;
  } else if (body.service_type === 'bulk_freight' || body.service_type === 'oversized') {
    baseFare = 15.00;
    perKm = 2.80;
  }

  const distanceFare = distanceKm * perKm;
  const weightFare = (body.cargo_weight_kg || 1) * 0.05;
  const volumeFare = (body.cargo_volume_m3 || 0.1) * 2.00;
  let subtotal = baseFare + distanceFare + weightFare + volumeFare;

  let coldChainSurcharge = 0;
  if (body.requires_refrigeration || body.service_type === 'cold_chain') {
    coldChainSurcharge = subtotal * 0.35;
  }

  let expressSurcharge = 0;
  if (body.service_type === 'express_same_day') {
    expressSurcharge = subtotal * 0.50;
  }

  let insurancePremium = 0;
  if (body.insurance_requested && body.cargo_value > 0) {
    insurancePremium = body.cargo_value * 0.015;
  }

  const totalFare = Number((subtotal + coldChainSurcharge + expressSurcharge + insurancePremium).toFixed(2));
  const estimatedHours = Number((0.5 + distanceKm / 35).toFixed(1));

  let recommendedVehicle = 'van';
  if (body.service_type === 'courier') recommendedVehicle = 'motorcycle';
  else if (body.requires_refrigeration || body.service_type === 'cold_chain') recommendedVehicle = 'refrigerated_van';
  else if (body.cargo_weight_kg > 150 || body.service_type === 'bulk_freight') recommendedVehicle = 'truck_large';

  return reply.send({
    quote_id: `QTE-${Date.now()}`,
    service_type: body.service_type,
    distance_km: distanceKm,
    estimated_transit_hours: estimatedHours,
    recommended_vehicle: recommendedVehicle,
    breakdown: {
      base_fare: baseFare,
      distance_fare: Number(distanceFare.toFixed(2)),
      weight_fare: Number(weightFare.toFixed(2)),
      volume_fare: Number(volumeFare.toFixed(2)),
      cold_chain_surcharge: Number(coldChainSurcharge.toFixed(2)),
      express_surcharge: Number(expressSurcharge.toFixed(2)),
      insurance_premium: Number(insurancePremium.toFixed(2)),
      total_fare: totalFare,
    },
    sla_guarantee: 'On-time delivery SLA with automated GPS proof-of-delivery (OTP + signature)',
    timestamp: new Date().toISOString()
  });
});

// Cold-chain IoT telemetry ingestion. Sensors authenticate with a shared device key
// (IOT_DEVICE_KEY); people use an ops/admin/driver token.
const iotDeviceKey = getEnv('IOT_DEVICE_KEY', '');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const telemetryGuard = async (req, reply) => {
  const presented = req.headers['x-device-key'];
  if (iotDeviceKey && typeof presented === 'string' && safeEqual(presented, iotDeviceKey)) return;
  if (!opsAuthRequired) return;      // local development without ops auth
  await authenticate(req, reply);
  if (reply.sent) return;
  return requireRole('admin', 'ops', 'driver')(req, reply);
};

async function getColdChainShipments() {
  if (!dbConnected) return inMemoryStore.coldChainShipments;
  const { rows } = await query(`
    SELECT delivery_number AS id, cargo_description AS cargo, current_temp_celsius AS current_temp_c,
           temp_min_celsius AS min_temp_c, temp_max_celsius AS max_temp_c, temp_alerts_count, updated_at
    FROM deliveries
    WHERE requires_refrigeration AND status IN ('pickup_scheduled','in_transit','out_for_delivery')
  `);
  return rows.map((r) => {
    const t = r.current_temp_c === null ? null : Number(r.current_temp_c);
    const outOfRange = t !== null && ((r.min_temp_c !== null && t < Number(r.min_temp_c)) || (r.max_temp_c !== null && t > Number(r.max_temp_c)));
    return { ...r, current_temp_c: t, status: outOfRange ? 'WARNING' : 'NORMAL' };
  });
}

app.post('/api/v1/cold-chain/telemetry', { preHandler: telemetryGuard }, async (req, reply) => {
  const body = validate(schemas.coldChainTelemetry, req.body);

  let delivery = null;
  if (dbConnected) {
    const { rows } = await query(
      'SELECT id, customer_id, delivery_number, temp_min_celsius, temp_max_celsius FROM deliveries WHERE delivery_number = $1 OR id::text = $1',
      [body.delivery_id]
    );
    delivery = rows[0] || null;
    if (!delivery) return reply.code(404).send({ error: 'Delivery not found' });
  }

  const minThreshold = delivery?.temp_min_celsius != null ? Number(delivery.temp_min_celsius) : 2.0;
  const maxThreshold = delivery?.temp_max_celsius != null ? Number(delivery.temp_max_celsius) : 8.0;

  const isExcursion = body.temperature_c < minThreshold || body.temperature_c > maxThreshold;
  let severity = 'normal';
  let alert = null;

  if (isExcursion) {
    const delta = body.temperature_c > maxThreshold ? (body.temperature_c - maxThreshold) : (minThreshold - body.temperature_c);
    severity = delta > 3.0 ? 'critical' : 'warning';
    alert = {
      id: `ALT-CC-${Date.now()}`,
      type: severity,
      icon: '🌡️',
      title: `Cold Chain Excursion: ${body.delivery_id}`,
      desc: `Sensor reading ${body.temperature_c.toFixed(1)}°C outside ${minThreshold}°C–${maxThreshold}°C target. Delta: ${delta.toFixed(1)}°C. Battery: ${body.battery_pct}%.`,
      time: 'Just now',
      timestamp: Date.now()
    };
    inMemoryStore.alerts.unshift(alert);
    if (inMemoryStore.alerts.length > 20) inMemoryStore.alerts.pop();

    io.to('ops:alerts').emit('cold_chain:alert', alert);
    if (delivery) io.to(`user:${delivery.customer_id}`).emit('delivery:temperature_alert', { delivery_id: delivery.id, temperature_c: body.temperature_c });
  }

  if (delivery) {
    await query(
      'UPDATE deliveries SET current_temp_celsius = $1, current_lat = $2, current_lng = $3, temp_alerts_count = temp_alerts_count + $4 WHERE id = $5',
      [body.temperature_c, body.lat, body.lng, isExcursion ? 1 : 0, delivery.id]
    );
  } else {
    const existing = inMemoryStore.coldChainShipments.find(s => s.id === body.delivery_id);
    if (existing) {
      existing.current_temp_c = body.temperature_c;
      existing.status = isExcursion ? (severity === 'critical' ? 'CRITICAL' : 'WARNING') : 'NORMAL';
      existing.battery = `${body.battery_pct}%`;
      existing.updated_at = new Date().toISOString();
    }
  }

  const aiRisk = await AI.checkColdChain({
    shipment_id: body.delivery_id,
    current_temp_c: body.temperature_c,
    target_min_c: minThreshold,
    target_max_c: maxThreshold,
  });

  return reply.send({
    logged: true,
    delivery_id: body.delivery_id,
    temperature_c: body.temperature_c,
    is_excursion: isExcursion,
    severity,
    ai_risk: aiRisk,
    alert,
    timestamp: new Date().toISOString()
  });
});

// Active cold-chain shipments list
app.get('/api/v1/cold-chain/shipments', { preHandler: opsGuard }, async (req, reply) => {
  const shipments = await getColdChainShipments();
  return reply.send({
    demo: !dbConnected,
    shipments,
    total_monitored: shipments.length,
    active_excursions: shipments.filter(s => s.status !== 'NORMAL').length,
    timestamp: new Date().toISOString()
  });
});

// Cold-chain compliance & stability audit report (public / verified)
// Temperature summary for a tracked shipment. Public, so it is keyed by the tracking slug
// like /track. It reports recorded readings only; it is not a regulatory release certificate.
app.get('/api/v1/track/:slug/temperature-report', async (req, reply) => {
  const delivery = await findTrackedDelivery(req.params.slug);
  if (!delivery) return reply.code(404).send({ error: 'Tracking not found' });
  const temperature = temperatureSummary(delivery);
  if (!temperature) return reply.code(404).send({ error: 'This shipment is not temperature-controlled' });

  const verdict = temperature.status === 'NO_DATA' ? 'NO_DATA'
    : temperature.status === 'OUT_OF_RANGE' ? 'OUT_OF_RANGE_NOW'
    : temperature.excursion_readings > 0 ? 'REVIEW_EXCURSIONS'
    : 'ALL_READINGS_IN_RANGE';

  return reply.send({
    report_id: `TR-${delivery.delivery_number}`,
    delivery_number: delivery.delivery_number,
    cargo_description: delivery.cargo_description,
    status: delivery.status,
    temperature,
    verdict,
    delivered_at: delivery.delivered_at || null,
    generated_at: new Date().toISOString(),
    is_demo: delivery.is_demo,
  });
});

// ============================================================
// ROUTES — DRIVERS
// ============================================================

// Driver self-registration. The account cannot go online until an admin approves it.
app.post('/api/v1/drivers/register', { preHandler: requireDatabase, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
  const body = validate(schemas.registerDriver, req.body);

  const { rows: existing } = await query('SELECT id FROM users WHERE email = $1 OR phone = $2', [body.email, body.phone]);
  if (existing.length) return reply.code(409).send({ error: 'Email or phone already registered' });

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = await bcrypt.hash(body.password, config.app.bcryptRounds);
  const referralCode = `NX${Date.now().toString(36).toUpperCase()}${randomDigits(2)}`;

  const result = await transaction(async (client) => {
    const { rows: [user] } = await client.query(`
      INSERT INTO users (email, phone, first_name, last_name, password_hash, salt, role, referral_code, signup_source)
      VALUES ($1, $2, $3, $4, $5, $6, 'driver', $7, 'driver_app')
      RETURNING id, email, phone, first_name, last_name, role
    `, [body.email, body.phone, body.first_name, body.last_name, passwordHash, salt, referralCode]);

    const { rows: [driver] } = await client.query(`
      INSERT INTO drivers (user_id, driver_number, service_types)
      VALUES ($1, $2, $3::service_type[])
      RETURNING id, driver_number
    `, [user.id, `DRV-${Date.now()}-${randomDigits(3)}`, SERVICE_BY_MODE[body.mode]]);

    const v = body.vehicle;
    await client.query(`
      INSERT INTO vehicles (driver_id, plate_number, make, model, year, color, vehicle_type, has_refrigeration)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [driver.id, v.plate_number, v.make, v.model, v.year, v.color, v.vehicle_type, v.vehicle_type === 'refrigerated']);

    return { user, driver };
  });

  const { token, refreshToken } = await issueAuthTokens(result.user);
  return reply.code(201).send({
    user: result.user,
    driver: { id: result.driver.id, driver_number: result.driver.driver_number, approved: false },
    token,
    refresh_token: refreshToken,
    message: 'Registration received. An administrator must approve your account before you can go online.',
  });
});

// Update driver location (called from driver app every few seconds)
app.post('/api/v1/driver/location', { preHandler: [authenticate, requireDatabase, requireDriver] }, async (req, reply) => {
  const { lat, lng, heading, speed_kmh, accuracy_m, battery_pct } = validate(schemas.driverLocation, req.body);
  const driverId = req.driver.id;

  await query(`
    UPDATE drivers SET
      current_location = ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)::geography,
      current_heading = $3,
      current_speed_kmh = $4,
      location_updated_at = NOW()
    WHERE id = $5
  `, [lng, lat, heading ?? null, speed_kmh ?? null, driverId]);

  // Location history (TimescaleDB hypertable)
  await query(`
    INSERT INTO driver_locations (time, driver_id, location, lat, lng, speed_kmh, heading, accuracy_m, battery_pct, trip_id)
    VALUES (NOW(), $1, ST_SetSRID(ST_MakePoint($2::float8, $3::float8), 4326)::geography, $3, $2, $4, $5, $6, $7,
            (SELECT id FROM trips WHERE driver_id = $1 AND status IN ('driver_en_route','arrived','in_progress') LIMIT 1))
  `, [driverId, lng, lat, speed_kmh ?? null, heading ?? null, accuracy_m ?? null, battery_pct ?? null]);

  await Cache.set(`driver_loc:${req.user.id}`, { lat, lng, heading, speed_kmh }, 15);

  // Push the position to riders and shippers with a live job
  const { rows: activeTrips } = await query(
    "SELECT customer_id FROM trips WHERE driver_id = $1 AND status IN ('driver_en_route', 'arrived', 'in_progress')",
    [driverId]
  );
  for (const { customer_id } of activeTrips) {
    io.to(`user:${customer_id}`).emit('driver:location', { lat, lng, heading, speed_kmh });
  }
  const { rows: activeDeliveries } = await query(
    "UPDATE deliveries SET current_lat = $2, current_lng = $3 WHERE driver_id = $1 AND status IN ('pickup_scheduled','in_transit','out_for_delivery') RETURNING customer_id",
    [driverId, lat, lng]
  );
  for (const { customer_id } of activeDeliveries) {
    io.to(`user:${customer_id}`).emit('driver:location', { lat, lng, heading, speed_kmh });
  }

  return reply.send({ received: true });
});


// Toggle driver online/offline
app.post('/api/v1/driver/status', { preHandler: [authenticate, requireDatabase, requireDriver] }, async (req, reply) => {
  const { status } = validate(schemas.driverStatus, req.body);

  if (status !== 'offline' && !req.driver.onboarding_completed) {
    return reply.code(403).send({ error: 'Your account is pending approval', code: 'pending_approval' });
  }
  if (req.driver.status === 'on_trip' && status !== 'on_trip') {
    return reply.code(409).send({ error: 'Finish your current job before changing status' });
  }
  if (req.driver.status === 'suspended') {
    return reply.code(403).send({ error: 'Account suspended' });
  }

  await query('UPDATE drivers SET status = $1::driver_status, is_online = $2 WHERE id = $3', [status, status !== 'offline', req.driver.id]);
  query('REFRESH MATERIALIZED VIEW active_drivers_view').catch(() => {});

  return reply.send({ status, message: `You are now ${status}` });
});


// Driver earnings summary
app.get('/api/v1/driver/earnings', { preHandler: [authenticate, requireDatabase, requireDriver] }, async (req, reply) => {
  const period = ['today', 'week', 'month'].includes(req.query.period) ? req.query.period : 'week';
  const interval = { today: '1 day', week: '7 days', month: '30 days' }[period];

  const { rows: [earnings] } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') as completed_trips,
      COALESCE(SUM(driver_earnings) FILTER (WHERE status = 'completed'), 0) as total_earnings,
      COALESCE(AVG(driver_earnings) FILTER (WHERE status = 'completed'), 0) as avg_per_trip,
      AVG(customer_rating) FILTER (WHERE customer_rating IS NOT NULL) as avg_rating,
      COALESCE(SUM(actual_distance_km) FILTER (WHERE status = 'completed'), 0) as total_km,
      COALESCE(SUM(EXTRACT(EPOCH FROM (trip_completed_at - trip_started_at))/3600) FILTER (WHERE status = 'completed'), 0) as total_hours
    FROM trips
    WHERE driver_id = $1
    AND created_at > NOW() - $2::interval
  `, [req.driver.id, interval]);

  const { rows: [freight] } = await query(`
    SELECT COUNT(*) as completed_deliveries, COALESCE(SUM(driver_earnings), 0) as total_earnings
    FROM deliveries WHERE driver_id = $1 AND status = 'delivered' AND delivered_at > NOW() - $2::interval
  `, [req.driver.id, interval]);

  return reply.send({ period, earnings, freight });
});

// Current job(s): lets mobile clients poll instead of relying on a socket for offers.
app.get('/api/v1/driver/jobs/current', { preHandler: [authenticate, requireDatabase, requireDriver] }, async (req, reply) => {
  const { rows: trips } = await query(`
    SELECT id, trip_number, status, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, total_fare, driver_assigned_at
    FROM trips WHERE driver_id = $1 AND status IN ('accepted','driver_en_route','arrived','in_progress')
  `, [req.driver.id]);
  const { rows: deliveries } = await query(`
    SELECT id, delivery_number, status, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng,
           cargo_description, cargo_weight_kg, total_fare
    FROM deliveries WHERE driver_id = $1 AND status IN ('pending','pickup_scheduled','in_transit','out_for_delivery')
  `, [req.driver.id]);
  return reply.send({ trips, deliveries, respond_within_sec: driverResponseTimeoutMs / 1000 });
});

for (const action of ['accept', 'decline', 'arrive', 'start', 'complete']) {
  app.post(`/api/v1/driver/trips/:tripId/${action}`, { preHandler: [authenticate, requireDatabase, requireDriver] }, async (req, reply) => {
    if (!UUID_RE.test(req.params.tripId)) return reply.code(404).send({ error: 'Trip not found' });
    const result = await driverTripAction(req.driver, req.params.tripId, action, req.body || {});
    return reply.code(result.code).send(result.body);
  });
}

for (const action of ['accept', 'decline', 'pickup', 'deliver']) {
  app.post(`/api/v1/driver/deliveries/:id/${action}`, { preHandler: [authenticate, requireDatabase, requireDriver] }, async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: 'Delivery not found' });
    const result = await driverDeliveryAction(req.driver, req.params.id, action, req.body || {});
    return reply.code(result.code).send(result.body);
  });
}

// Drivers choose which side of the business they serve: 'ride', 'freight' or 'both'.
app.post('/api/v1/driver/mode', { preHandler: [authenticate, requireDatabase, requireDriver] }, async (req, reply) => {
  const { mode } = validate(schemas.driverMode, req.body);
  await query('UPDATE drivers SET service_types = $1::service_type[] WHERE id = $2', [SERVICE_BY_MODE[mode], req.driver.id]);

  const event = { driver_id: req.driver.id, mode, timestamp: new Date().toISOString() };
  io.to('ops:fleet').emit('fleet:mode_updated', event);
  return reply.send({ success: true, ...event });
});

// Fleet snapshot: live drivers from the database (demo drivers only when no database is connected).
async function getFleetSnapshot() {
  if (!dbConnected) return { demo: true, drivers: inMemoryStore.drivers };
  const { rows } = await query(`
    SELECT d.id, u.first_name || ' ' || u.last_name AS name, d.status, d.is_online, d.service_types::text[] AS service_types,
           d.rating_overall AS rating,
           ST_Y(d.current_location::geometry) AS lat, ST_X(d.current_location::geometry) AS lng,
           v.vehicle_type
    FROM drivers d
    JOIN users u ON u.id = d.user_id
    LEFT JOIN LATERAL (SELECT vehicle_type FROM vehicles WHERE driver_id = d.id AND is_active ORDER BY created_at LIMIT 1) v ON TRUE
    WHERE d.onboarding_completed AND d.status <> 'suspended'
    ORDER BY d.is_online DESC, d.updated_at DESC
    LIMIT 500
  `);
  return {
    demo: false,
    drivers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      lat: r.lat === null ? null : Number(r.lat),
      lng: r.lng === null ? null : Number(r.lng),
      mode: modeFromServiceTypes(r.service_types),
      vehicle_type: r.vehicle_type,
      service_types: r.service_types,
      status: r.status,
      is_online: r.is_online,
      rating: Number(r.rating),
    })),
  };
}

// Live drivers list with coordinates and operating mode
app.get('/api/v1/fleet/drivers', { preHandler: opsGuard }, async (req, reply) => {
  const { demo, drivers } = await getFleetSnapshot();
  return reply.send({
    demo,
    drivers,
    total: drivers.length,
    counts: {
      ride: drivers.filter(d => d.mode === 'ride').length,
      freight: drivers.filter(d => d.mode === 'freight').length,
      both: drivers.filter(d => d.mode === 'both').length,
    },
    timestamp: new Date().toISOString()
  });
});

// Diurnal Fleet Rebalance (Peak Rides vs Peak Freight balancer). Triggers an alert, so it is a POST.
app.post('/api/v1/fleet/rebalance', { preHandler: opsGuard }, async (req, reply) => {
  const currentHour = new Date().getHours();
  const isMiddayFreight = currentHour >= 10 && currentHour <= 16;
  const isCommuteRide = (currentHour >= 7 && currentHour <= 9) || (currentHour >= 17 && currentHour <= 20);

  const { demo, drivers } = await getFleetSnapshot();
  const dualDrivers = drivers.filter(d => d.mode === 'both' && d.status === 'available').length;

  let mode = 'balanced';
  let driversShifted = Math.floor(dualDrivers * 0.5);
  let reasoning = `Hour ${currentHour}:00 balanced standby distribution.`;

  if (isMiddayFreight) {
    mode = 'shift_to_freight';
    driversShifted = Math.floor(dualDrivers * 0.55);
    reasoning = `Midday B2B freight & e-commerce parcel peak (Hour ${currentHour}:00). Passenger demand is off-peak. Shifting ${driversShifted} idle dual-mode drivers to freight/cold-chain delivery.`;
  } else if (isCommuteRide) {
    mode = 'shift_to_ride';
    driversShifted = Math.floor(dualDrivers * 0.65);
    reasoning = `Rush-hour passenger mobility surge (Hour ${currentHour}:00). Prioritizing passenger taxi rides to maintain < 3.8 min average ETA.`;
  }

  let activeRides = inMemoryStore.trips.length;
  let activeFreight = inMemoryStore.deliveries.length;
  if (dbConnected) {
    const { rows: [c] } = await query(`
      SELECT (SELECT COUNT(*) FROM trips WHERE status IN ('requested','searching','accepted')) AS rides,
             (SELECT COUNT(*) FROM deliveries WHERE status = 'pending') AS freight
    `);
    activeRides = Number(c.rides);
    activeFreight = Number(c.freight);
  }

  const aiResult = await AI.rebalanceFleet({
    hour_of_day: currentHour,
    active_ride_requests: activeRides,
    active_freight_requests: activeFreight,
    available_dual_drivers: dualDrivers,
  });

  const rebalanceData = {
    demo,
    hour: currentHour,
    mode: aiResult?.mode || mode,
    drivers_rebalanced: aiResult?.drivers_to_rebalance ?? driversShifted,
    deadhead_reduction_pct: aiResult?.projected_deadhead_reduction_pct ?? null,
    projected_earnings_boost_pct: aiResult?.projected_driver_revenue_boost_pct ?? null,
    reasoning: aiResult?.reasoning || reasoning,
    source: aiResult ? 'ai_engine' : 'rule_based',
    timestamp: new Date().toISOString()
  };

  const alert = {
    id: `ALT-REB-${Date.now()}`,
    type: 'info',
    icon: '🔄',
    title: 'Diurnal Fleet Rebalance Triggered',
    desc: rebalanceData.reasoning,
    time: 'Just now',
    timestamp: Date.now()
  };
  inMemoryStore.alerts.unshift(alert);
  if (inMemoryStore.alerts.length > 20) inMemoryStore.alerts.pop();

  io.to('ops:fleet').emit('fleet:rebalanced', rebalanceData);
  io.to('ops:alerts').emit('ops:alert', alert);

  return reply.send(rebalanceData);
});

// ============================================================
// ROUTES — PAYMENTS
// ============================================================

app.post('/api/v1/payments/setup-intent', { preHandler: [authenticate, requireDatabase, idempotencyGuard] }, async (req, reply) => {
  try {
    // Reuse the Stripe customer so repeated calls do not create duplicates.
    const { rows: [row] } = await query('SELECT stripe_customer_id FROM users WHERE id = $1', [req.user.id]);
    let customerId = row?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: `${req.user.first_name} ${req.user.last_name}`,
        metadata: { nexus_user_id: req.user.id }
      });
      customerId = customer.id;
      await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.user.id]);
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
    });

    return reply.send({
      client_secret: setupIntent.client_secret,
      customer_id: customerId,
    });
  } catch (err) {
    if (err?.type && String(err.type).startsWith('Stripe')) {
      logger.error({ err: { type: err.type, code: err.code, message: err.message } }, 'Stripe request failed');
      return reply.code(502).send({ error: 'Payment provider unavailable', request_id: req.requestId });
    }
    throw err;
  }
});


// Registered as a child plugin so it loads after fastify-raw-body: routes declared on `app` directly
// are added before the plugin's onRoute hook exists, and would never receive req.rawBody.
app.register(async (instance) => {
  instance.post('/api/v1/webhooks/stripe', { config: { rawBody: true } }, async (req, reply) => {
    if (!config.stripe.webhookSecret) {
      return reply.code(500).send({ error: 'Stripe webhook secret is not configured' });
    }

    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return reply.code(400).send({ error: 'Missing Stripe signature header' });
    }
    if (Array.isArray(signature)) {
      return reply.code(400).send({ error: 'Invalid Stripe signature header' });
    }

    if (!req.rawBody) {
      return reply.code(400).send({ error: 'Missing raw request body for webhook verification' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        signature,
        config.stripe.webhookSecret
      );
    } catch (err) {
      return reply.code(400).send({ error: 'Invalid signature' });
    }

    const insertResult = await query(
      `INSERT INTO stripe_webhook_events (event_id, event_type, payload, signature)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.id, event.type, event, signature]
    );

    // Stripe may retry already-processed events. Acknowledge duplicates safely.
    if (insertResult.rowCount === 0) {
      await query(
        `UPDATE stripe_webhook_events
         SET delivery_attempt = delivery_attempt + 1, received_at = NOW()
         WHERE event_id = $1`,
        [event.id]
      );
      return reply.send({ received: true, duplicate: true });
    }
  
    try {
      switch (event.type) {
        case 'payment_intent.succeeded': {
          const pi = event.data.object;
          await query(
            "UPDATE payments SET status = 'captured', captured_at = NOW() WHERE gateway_ref = $1",
            [pi.id]
          );
          logger.info({ paymentId: pi.id }, 'Payment captured');
          break;
        }
        case 'payment_intent.payment_failed': {
          const pi = event.data.object;
          await query(
            "UPDATE payments SET status = 'failed', failed_at = NOW() WHERE gateway_ref = $1",
            [pi.id]
          );
          break;
        }
        case 'charge.dispute.created': {
          const dispute = event.data.object;
          logger.warn({ dispute }, 'Payment dispute created');
          // Auto-flag for review
          await query(
            "UPDATE payments SET status = 'disputed' WHERE gateway_ref = $1",
            [dispute.charge]
          );
          break;
        }
        default:
          logger.info({ eventId: event.id, type: event.type }, 'Unhandled Stripe webhook type');
      }

      await query(
        `UPDATE stripe_webhook_events
         SET processed_at = NOW(), processing_error = NULL
         WHERE event_id = $1`,
        [event.id]
      );
    } catch (err) {
      await query(
        `UPDATE stripe_webhook_events
         SET processing_error = $2
         WHERE event_id = $1`,
        [event.id, err.message || 'Webhook processing failed']
      );
      throw err;
    }
  
    return reply.send({ received: true });
  });
});

// ============================================================
// ROUTES — ADMIN & OPERATIONS
// ============================================================

app.get('/api/v1/admin/dashboard', { preHandler: [authenticate, requireRole('admin', 'ops'), requireDatabase] }, async (req, reply) => {
  const [tripStats, driverStats, revenueStats, demandForecast] = await Promise.all([
    query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE status IN ('searching','accepted','driver_en_route','arrived','in_progress')) as active,
        AVG(customer_rating) FILTER (WHERE customer_rating IS NOT NULL) as avg_rating,
        AVG(eta_accuracy_seconds) as avg_eta_accuracy_sec
      FROM trips WHERE DATE(created_at) = CURRENT_DATE
    `),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE is_online = TRUE) as online,
        COUNT(*) FILTER (WHERE status = 'available') as available,
        COUNT(*) FILTER (WHERE status = 'on_trip') as on_trip,
        COUNT(*) FILTER (WHERE NOT onboarding_completed) as pending_approval,
        COUNT(*) as total
      FROM drivers
    `),
    query(`
      SELECT
        SUM(total_fare) FILTER (WHERE status = 'completed') as today_revenue,
        SUM(platform_fee) FILTER (WHERE status = 'completed') as today_profit
      FROM trips WHERE DATE(created_at) = CURRENT_DATE
    `),
    AI.forecastDemand([0, 1, 2, 3, 4]).catch(() => null)
  ]);

  return reply.send({
    trips: tripStats.rows[0],
    drivers: driverStats.rows[0],
    revenue: revenueStats.rows[0],
    demand_forecast: demandForecast,
    timestamp: new Date().toISOString(),
  });
});

// Driver approval workflow
app.get('/api/v1/admin/drivers', { preHandler: [authenticate, requireRole('admin', 'ops'), requireDatabase] }, async (req, reply) => {
  const pendingOnly = req.query.status === 'pending';
  const { rows } = await query(`
    SELECT d.id, d.driver_number, d.status, d.is_online, d.onboarding_completed, d.background_check_status,
           d.service_types::text[] AS service_types, d.created_at, u.first_name, u.last_name, u.email, u.phone
    FROM drivers d JOIN users u ON u.id = d.user_id
    ${pendingOnly ? 'WHERE NOT d.onboarding_completed' : ''}
    ORDER BY d.created_at DESC LIMIT 200
  `);
  return reply.send({ drivers: rows, total: rows.length });
});

app.post('/api/v1/admin/drivers/:id/approve', { preHandler: [authenticate, requireRole('admin', 'ops'), requireDatabase] }, async (req, reply) => {
  if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: 'Driver not found' });
  const { rows: [driver] } = await query(`
    UPDATE drivers SET onboarding_completed = TRUE, background_check_status = 'approved', background_check_date = CURRENT_DATE
    WHERE id = $1 RETURNING id, driver_number, onboarding_completed
  `, [req.params.id]);
  if (!driver) return reply.code(404).send({ error: 'Driver not found' });
  await auditLog(req, 'driver.approve', 'driver', driver.id);
  return reply.send({ driver, message: 'Driver approved' });
});

app.post('/api/v1/admin/drivers/:id/suspend', { preHandler: [authenticate, requireRole('admin'), requireDatabase] }, async (req, reply) => {
  if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: 'Driver not found' });
  const { rows: [driver] } = await query(`
    UPDATE drivers SET status = 'suspended', is_online = FALSE WHERE id = $1 RETURNING id, driver_number, status
  `, [req.params.id]);
  if (!driver) return reply.code(404).send({ error: 'Driver not found' });
  await auditLog(req, 'driver.suspend', 'driver', driver.id);
  return reply.send({ driver, message: 'Driver suspended' });
});

async function auditLog(req, action, resource, resourceId) {
  try {
    await query(
      'INSERT INTO audit_logs (actor_id, actor_role, action, resource, resource_id, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [req.user.id, req.user.role, action, resource, resourceId, req.ip, String(req.headers['user-agent'] || '').slice(0, 300)]
    );
  } catch (err) {
    logger.error({ err, action }, 'Audit log write failed');
  }
}

function diurnalState(hour) {
  if (hour >= 10 && hour <= 16) return 'MIDDAY_FREIGHT_PEAK';
  if ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 20)) return 'COMMUTE_RIDE_PEAK';
  return 'BALANCED';
}

// Unified operations overview for the dashboards. Real numbers when the database is connected;
// otherwise clearly-flagged sample data (demo: true).
app.get('/api/v1/ops/overview', { preHandler: opsGuard }, async (req, reply) => {
  const currentHour = new Date().getHours();

  if (!dbConnected) {
    const drivers = inMemoryStore.drivers;
    return reply.send({
      demo: true,
      status: 'ONLINE',
      version: '3.0.0',
      platform: 'NEXUS LOGISTICS GROUP',
      metrics: {
        active_trips: inMemoryStore.trips.filter(t => t.status !== 'completed').length,
        active_deliveries: inMemoryStore.deliveries.filter(d => d.status !== 'delivered').length,
        completed_today: null, today_revenue: null, today_profit: null,
        avg_eta_minutes: null, dispatch_ai_score_pct: null, deadhead_reduction_pct: null,
      },
      fleet: {
        online_total: drivers.length,
        ride_only: drivers.filter(d => d.mode === 'ride').length,
        freight_only: drivers.filter(d => d.mode === 'freight').length,
        dual_mode: drivers.filter(d => d.mode === 'both').length,
        drivers,
      },
      cold_chain: {
        monitored_shipments: inMemoryStore.coldChainShipments.length,
        active_excursions: inMemoryStore.coldChainShipments.filter(s => s.status !== 'NORMAL').length,
        shipments: inMemoryStore.coldChainShipments,
      },
      diurnal: { current_hour: currentHour, state: diurnalState(currentHour) },
      trips: inMemoryStore.trips,
      deliveries: inMemoryStore.deliveries,
      alerts: inMemoryStore.alerts.slice(0, 10),
      timestamp: new Date().toISOString()
    });
  }

  const [{ drivers }, stats, trips, deliveries, cold] = await Promise.all([
    getFleetSnapshot(),
    query(`
      SELECT
        (SELECT COUNT(*) FROM trips WHERE status IN ('searching','accepted','driver_en_route','arrived','in_progress')) AS active_trips,
        (SELECT COUNT(*) FROM deliveries WHERE status IN ('pending','pickup_scheduled','in_transit','out_for_delivery')) AS active_deliveries,
        (SELECT COUNT(*) FROM trips WHERE status = 'completed' AND trip_completed_at::date = CURRENT_DATE)
          + (SELECT COUNT(*) FROM deliveries WHERE status = 'delivered' AND delivered_at::date = CURRENT_DATE) AS completed_today,
        (SELECT COALESCE(SUM(total_fare), 0) FROM trips WHERE status = 'completed' AND trip_completed_at::date = CURRENT_DATE)
          + (SELECT COALESCE(SUM(total_fare), 0) FROM deliveries WHERE status = 'delivered' AND delivered_at::date = CURRENT_DATE) AS today_revenue,
        (SELECT COALESCE(SUM(platform_fee), 0) FROM trips WHERE status = 'completed' AND trip_completed_at::date = CURRENT_DATE)
          + (SELECT COALESCE(SUM(platform_fee), 0) FROM deliveries WHERE status = 'delivered' AND delivered_at::date = CURRENT_DATE) AS today_profit,
        (SELECT AVG(initial_eta_pickup_min) FROM trips WHERE created_at::date = CURRENT_DATE AND initial_eta_pickup_min IS NOT NULL) AS avg_eta,
        (SELECT AVG(dispatch_ai_score) * 100 FROM trips WHERE created_at::date = CURRENT_DATE AND dispatch_ai_score IS NOT NULL) AS ai_score
    `),
    query(`
      SELECT t.id, t.trip_number AS ref, t.pickup_address AS "from", t.dropoff_address AS "to", t.status, t.total_fare AS fare, t.service_type AS type,
             du.first_name || ' ' || LEFT(du.last_name, 1) || '.' AS driver, t.initial_eta_pickup_min AS eta_min
      FROM trips t
      LEFT JOIN drivers dr ON dr.id = t.driver_id
      LEFT JOIN users du ON du.id = dr.user_id
      WHERE t.status IN ('searching','accepted','driver_en_route','arrived','in_progress') ORDER BY t.created_at DESC LIMIT 25
    `),
    query(`
      SELECT d.id, d.delivery_number AS ref, d.pickup_address AS "from", d.dropoff_address AS "to", d.status, d.total_fare AS fare,
             d.cargo_weight_kg AS weight, d.current_temp_celsius AS current_temp_c, d.requires_refrigeration,
             CASE WHEN d.requires_refrigeration THEN 'cold_chain' ELSE 'freight' END AS type,
             du.first_name || ' ' || LEFT(du.last_name, 1) || '.' AS driver
      FROM deliveries d
      LEFT JOIN drivers dr ON dr.id = d.driver_id
      LEFT JOIN users du ON du.id = dr.user_id
      WHERE d.status IN ('pending','pickup_scheduled','in_transit','out_for_delivery') ORDER BY d.created_at DESC LIMIT 25
    `),
    getColdChainShipments(),
  ]);

  const s = stats.rows[0];
  const online = drivers.filter(d => d.is_online);
  const shipments = cold;

  return reply.send({
    demo: false,
    status: 'ONLINE',
    version: '3.0.0',
    platform: 'NEXUS LOGISTICS GROUP',
    metrics: {
      active_trips: Number(s.active_trips),
      active_deliveries: Number(s.active_deliveries),
      completed_today: Number(s.completed_today),
      today_revenue: Number(s.today_revenue),
      today_profit: Number(s.today_profit),
      avg_eta_minutes: s.avg_eta === null ? null : Number(Number(s.avg_eta).toFixed(1)),
      dispatch_ai_score_pct: s.ai_score === null ? null : Number(Number(s.ai_score).toFixed(1)),
      deadhead_reduction_pct: null,
    },
    fleet: {
      online_total: online.length,
      ride_only: online.filter(d => d.mode === 'ride').length,
      freight_only: online.filter(d => d.mode === 'freight').length,
      dual_mode: online.filter(d => d.mode === 'both').length,
      drivers,
    },
    cold_chain: {
      monitored_shipments: shipments.length,
      active_excursions: shipments.filter(x => x.status !== 'NORMAL').length,
      shipments,
    },
    diurnal: { current_hour: currentHour, state: diurnalState(currentHour) },
    trips: trips.rows,
    deliveries: deliveries.rows,
    alerts: inMemoryStore.alerts.slice(0, 10),
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// REAL-TIME WEBSOCKET (Socket.io)
// ============================================================

const io = new SocketIO({
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (!isProduction && config.cors.origins.length === 0) return cb(null, true);
      return cb(null, config.cors.origins.includes(origin));
    },
    credentials: true,
  },
});

function verifyAccessToken(token) {
  const decoded = app.jwt.verify(token);
  if (decoded.type === 'refresh') throw new Error('refresh token is not an access token');
  return decoded;
}

io.on('connection', (socket) => {
  logger.info({ socketId: socket.id }, 'Socket connected');

  // Operations dashboard: ops/admin only (when OPS_AUTH_REQUIRED, the default in production).
  socket.on('ops:join', async (payload) => {
    try {
      if (opsAuthRequired || payload?.token) {
        const decoded = verifyAccessToken(payload?.token || '');
        if (!['admin', 'ops'].includes(decoded.role)) throw new Error('forbidden');
      }
      socket.join('ops:alerts');
      socket.join('ops:fleet');
      const snapshot = dbConnected ? (await getFleetSnapshot()).drivers : inMemoryStore.drivers;
      socket.emit('ops:joined', {
        connected: true,
        time: new Date().toISOString(),
        drivers_count: snapshot.length,
      });
    } catch {
      socket.emit('ops:error', { message: 'Not authorized for operations stream' });
    }
  });

  socket.on('auth', async ({ token } = {}) => {
    try {
      const decoded = verifyAccessToken(token);
      if (await kv.get(`blacklist:${decoded.jti}`)) throw new Error('revoked');
      socket.userId = decoded.id;
      socket.role = decoded.role;

      socket.join(`user:${decoded.id}`);

      if (decoded.role === 'driver') {
        const driver = await getDriverByUserId(decoded.id);
        if (driver) {
          socket.driverId = driver.id;
          socket.join(`driver:${driver.id}`);
        }
      }

      socket.emit('auth:success', { userId: decoded.id, role: decoded.role });
    } catch {
      socket.emit('auth:error', { message: 'Invalid token' });
    }
  });

  // Driver actions over the socket share the same guarded state machine as the REST routes.
  const driverSocketAction = (event, action) => {
    socket.on(event, async (payload = {}, ack) => {
      const reply = (r) => { if (typeof ack === 'function') ack(r); };
      if (socket.role !== 'driver' || !socket.driverId) return reply({ code: 403, body: { error: 'Driver only' } });
      try {
        const driver = await getDriverByUserId(socket.userId);
        reply(await driverTripAction(driver, payload.tripId, action, payload));
      } catch (err) {
        logger.error({ err, event }, 'Socket trip action failed');
        reply({ code: 500, body: { error: 'Internal server error' } });
      }
    });
  };
  driverSocketAction('trip:accept', 'accept');
  driverSocketAction('trip:decline', 'decline');
  driverSocketAction('trip:arrive', 'arrive');
  driverSocketAction('trip:start', 'start');
  driverSocketAction('trip:complete', 'complete');

  socket.on('sos', async ({ tripId, lat, lng } = {}) => {
    if (!socket.userId || !UUID_RE.test(String(tripId))) return;
    try {
      const { rows: [trip] } = await query(`
        SELECT id, customer_id, driver_id FROM trips
        WHERE id = $1 AND (customer_id = $2 OR driver_id IN (SELECT id FROM drivers WHERE user_id = $2))
      `, [tripId, socket.userId]);
      if (!trip) return;

      logger.error({ socketId: socket.id, tripId, lat, lng }, 'SOS TRIGGERED');
      await query('UPDATE trips SET sos_triggered = TRUE, sos_at = NOW() WHERE id = $1', [tripId]);
      await query(`
        INSERT INTO safety_incidents (incident_ref, trip_id, driver_id, customer_id, type, severity, incident_lat, incident_lng)
        VALUES ($1, $2, $3, $4, 'sos', 'critical', $5, $6)
      `, [`INC-${Date.now()}-${randomDigits(3)}`, trip.id, trip.driver_id, trip.customer_id,
          Number.isFinite(Number(lat)) ? Number(lat) : null, Number.isFinite(Number(lng)) ? Number(lng) : null]);

      io.to('ops:alerts').emit('sos:emergency', { tripId, driverId: trip.driver_id, lat, lng, timestamp: new Date() });
    } catch (err) {
      logger.error({ err, tripId }, 'SOS handling failed');
    }
  });

  socket.on('disconnect', () => {
    logger.info({ socketId: socket.id }, 'Socket disconnected');

    // Mark an idle driver offline if no location update arrives within 60s of disconnecting.
    // Drivers on a job are left alone so the trip is not stranded.
    if (socket.driverId) {
      setTimeout(async () => {
        try {
          const loc = await Cache.get(`driver_loc:${socket.userId}`);
          if (!loc) {
            await query("UPDATE drivers SET is_online = FALSE, status = 'offline' WHERE id = $1 AND status = 'available'", [socket.driverId]);
          }
        } catch (err) {
          logger.error({ err }, 'Offline cleanup failed');
        }
      }, 60000);
    }
  });
});

// Live fleet telemetry for operations dashboards (only computed while someone is listening).
let heartbeatInFlight = false;
setInterval(async () => {
  const room = io.sockets.adapter.rooms.get('ops:fleet');
  if (!room || room.size === 0 || heartbeatInFlight) return;
  heartbeatInFlight = true;
  try {
    if (!dbConnected) {
      inMemoryStore.drivers.forEach(d => {          // demo mode only: drift the sample drivers
        d.lat += (Math.random() - 0.5) * 0.0004;
        d.lng += (Math.random() - 0.5) * 0.0004;
      });
    }
    const { demo, drivers } = await getFleetSnapshot();
    io.to('ops:fleet').emit('ops:heartbeat', { demo, drivers, timestamp: Date.now() });
  } catch (err) {
    logger.error({ err }, 'Heartbeat failed');
  } finally {
    heartbeatInFlight = false;
  }
}, 3000);

// ============================================================
// ERROR HANDLER
// ============================================================

app.setErrorHandler((err, req, reply) => {
  // Client errors (validation, auth, rate limit) are safe to describe; server errors are not.
  if (err.statusCode && err.statusCode < 500) {
    return reply.code(err.statusCode).send({
      error: err.message,
      details: err.errors,
      request_id: req.requestId
    });
  }
  
  logger.error({ requestId: req.requestId, err, url: req.url }, 'Unhandled error');
  return reply.code(500).send({ error: 'Internal server error', request_id: req.requestId });
});

// ============================================================
// STARTUP
// ============================================================

// Re-check the database periodically so a transient outage heals itself (and 503s stop).
async function probeDatabase() {
  try {
    await db.query('SELECT 1');
    if (!dbConnected) logger.info('Database connection restored');
    dbConnected = true;
  } catch {
    dbConnected = false;
  }
}

// Create or reset the admin account from ADMIN_EMAIL / ADMIN_PASSWORD. No default admin exists.
async function bootstrapAdmin() {
  const email = getEnv('ADMIN_EMAIL', '').toLowerCase();
  const password = getEnv('ADMIN_PASSWORD', '');
  if (!email || !password) return;
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');

  const passwordHash = await bcrypt.hash(password, config.app.bcryptRounds);
  await db.query(`
    INSERT INTO users (role, email, phone, first_name, last_name, password_hash, salt, is_verified, email_verified, referral_code)
    VALUES ('admin', $1, $2, 'System', 'Administrator', $3, '', TRUE, TRUE, $4)
    ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash, is_active = TRUE, is_banned = FALSE
  `, [email, `+0${Date.now()}`.slice(0, 20), passwordHash, `ADM${randomDigits(6)}`]);
  logger.info({ email }, '✅ Admin account ensured');
}

async function start() {
  try {
    validateRuntimeConfig(config);

    // Test DB connection with resilient fallback in development
    try {
      await db.query('SELECT 1');       // direct call: query() would hide a failure in dev
      dbConnected = true;
      logger.info('✅ Database connected');
      await ensureOperationalTables();
      logger.info('✅ Operational tables ensured');
      await bootstrapAdmin();
    } catch (e) {
      if (isProduction) throw e;
      logger.warn('⚠️ Database not reachable; continuing with in-memory store in development mode');
    }
    
    // Test Redis with resilient fallback in development
    try {
      await redis.connect();
      await redis.ping();
      redisConnected = true;
      logger.info('✅ Redis connected');
    } catch (e) {
      if (isProduction) throw e;
      logger.warn('⚠️ Redis not reachable; continuing with in-memory cache in development mode');
    }
    
    // Start Fastify
    await app.listen({ port: config.port, host: config.host });
    
    // Attach Socket.io
    io.attach(app.server);
    
    // Background workers
    setInterval(sweepDispatch, sweepIntervalMs).unref();
    setInterval(probeDatabase, 10000).unref();

    logger.info(`🚀 NEXUS LOGISTICS API running on port ${config.port}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  try {
    io.close();
    await app.close();
    await db.end();
    if (redisConnected) await redis.quit();
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();

module.exports = { app, db, redis, io };
