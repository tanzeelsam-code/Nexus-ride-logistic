import './router-compat.cjs';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { env as workerEnv } from 'cloudflare:workers';
import backend from '../backend_api.js';
const metrics = { startedAtMs:Date.now(),requestsTotal:0,requestDurationMsSum:0,requestDurationMsCount:0,authFailuresTotal:0,statusCounts:new Map() };

export function createSessionStore(db) {
  const table = 'nexora_private.runtime_kv';
  const store = {
    on() {}, async connect() {}, async quit() {},
    async ping() { await db.query('SELECT 1'); return 'PONG'; },
    async get(key) {
      const { rows } = await db.query(`SELECT value FROM ${table} WHERE key=$1 AND expires_at > NOW()`, [key]);
      return rows[0]?.value ?? null;
    },
    async set(key, value, ...args) {
      const ex = args.indexOf('EX');
      const ttl = ex >= 0 ? Number(args[ex + 1]) : 86400;
      const nx = args.includes('NX');
      const result = await db.query(`INSERT INTO ${table} (key,value,expires_at) VALUES ($1,$2,NOW()+($3*INTERVAL '1 second'))
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at
        ${nx ? `WHERE ${table}.expires_at <= NOW()` : ''} RETURNING key`, [key, String(value), ttl]);
      return result.rowCount ? 'OK' : null;
    },
    async setex(key, seconds, value) { return store.set(key, value, 'EX', seconds); },
    async del(key) { return (await db.query(`DELETE FROM ${table} WHERE key=$1`, [key])).rowCount; },
    async incr(key) {
      const { rows } = await db.query(`INSERT INTO ${table} (key,value,expires_at) VALUES ($1,'1',NOW()+INTERVAL '5 minutes')
        ON CONFLICT (key) DO UPDATE SET value=CASE WHEN ${table}.expires_at<=NOW() THEN '1' ELSE (${table}.value::bigint+1)::text END,
        expires_at=CASE WHEN ${table}.expires_at<=NOW() THEN EXCLUDED.expires_at ELSE ${table}.expires_at END RETURNING value`, [key]);
      return Number(rows[0].value);
    },
    async expire(key, seconds) { await db.query(`UPDATE ${table} SET expires_at=NOW()+($2*INTERVAL '1 second') WHERE key=$1`, [key, seconds]); }
  };
  return store;
}

function createRateStore(db) {
  return class RateStore {
    constructor(options) { this.options = options; }
    child(options) { return new RateStore(options); }
    incr(ip, cb, timeWindow = this.options.timeWindow) {
      // Each route receives its own namespace, supplied by the Fastify options.
      const route = this.options.routeInfo?.url || this.options.routeKey || 'global';
      const key = `rate:${route}:${ip}:${timeWindow}:${this.options.max}`;
      db.query(`INSERT INTO nexora_private.runtime_kv (key,value,expires_at) VALUES ($1,'1',NOW()+($2*INTERVAL '1 millisecond'))
        ON CONFLICT(key) DO UPDATE SET value=CASE WHEN nexora_private.runtime_kv.expires_at<=NOW() THEN '1' ELSE (nexora_private.runtime_kv.value::bigint+1)::text END,
        expires_at=CASE WHEN nexora_private.runtime_kv.expires_at<=NOW() THEN EXCLUDED.expires_at ELSE nexora_private.runtime_kv.expires_at END
        RETURNING value::int AS current,GREATEST(1,EXTRACT(EPOCH FROM expires_at-NOW())*1000)::int AS ttl`, [key,timeWindow]).then(r=>cb(null,r.rows[0]),cb);
    }
  };
}

// Routes and plugins are initialized once at module startup, within Cloudflare's
// startup budget. Only sockets and event buffers are scoped to each request.
const scope = new AsyncLocalStorage();
const db = {
  on() {},
  query(...args) { return scope.getStore().db.query(...args); },
  connect(...args) { return scope.getStore().db.connect(...args); }
};
const env = workerEnv;

  const RateStore = createRateStore(db);
  async function rateLimit(req,reply) {
    const configured = req.routeOptions.config?.rateLimit;
    const limits = [{ max:100,timeWindow:60000,routeInfo:{url:'global'} }];
    if (configured && typeof configured === 'object') limits.push({ ...configured, timeWindow:typeof configured.timeWindow === 'number' ? configured.timeWindow : 60000,routeInfo:{url:req.routeOptions.url} });
    for (const options of limits) {
      const store = new RateStore(options);
      const result = await new Promise((resolve,reject) => store.incr(req.ip,(error,value) => error ? reject(error) : resolve(value)));
      if (result.current > options.max) {
        reply.header('Retry-After',Math.ceil(result.ttl/1000));
        return reply.code(429).send({error:'Too many requests. Try again shortly.'});
      }
    }
  }
  const io = {
    on() {}, close() {}, sockets: { adapter: { rooms: new Map() } },
    to(audience) { return { emit(event,payload) { scope.getStore().emissions.push({ audience,event,payload }); } }; }
  };
  const api = backend.createBackend({ edge:true, db, metrics, rateLimit,
    passwords: {
      async genSalt() { return (await db.query("SELECT extensions.gen_salt('bf',12) AS salt")).rows[0].salt; },
      async hash(password,salt) {
        if (Buffer.byteLength(password,'utf8') > 72) throw new Error('Password exceeds bcrypt byte limit');
        const query = typeof salt === 'string' ? 'SELECT extensions.crypt($1,$2) AS hash' : "SELECT extensions.crypt($1,extensions.gen_salt('bf',12)) AS hash";
        return (await db.query(query,typeof salt === 'string' ? [password,salt] : [password])).rows[0].hash;
      },
      async compare(password,hash) {
        if (Buffer.byteLength(password,'utf8') > 72) return false;
        // pgcrypto accepts the compatible 2a prefix; Node bcrypt uses 2b.
        const compatibleHash = String(hash).replace(/^\$2[by]\$/, '$2a$');
        return (await db.query('SELECT extensions.crypt($1,$2)=$2 AS matched',[password,compatibleHash])).rows[0].matched;
      }
    }, redis:createSessionStore(db),  io,
    env:{ ...env, NODE_ENV:'production', ALLOWED_ORIGINS:env.ALLOWED_ORIGINS || env.PUBLIC_APP_URL, STRIPE_SECRET_KEY:env.STRIPE_SECRET_KEY || 'sk_test_unconfigured' } });
// Plugin timeout timers are disabled for this startup-only initialization.
await api.app.ready();
api.app.server.listen(0);
const port = api.app.server.address().port;

export async function openRuntime(env) {
  if (!env.DATABASE?.connectionString || !env.JWT_SECRET) throw new Error('Worker database and authentication secrets are missing');
  // Hyperdrive owns verified origin TLS and pooling. Never share this socket
  // between Worker request contexts, even though route metadata is reused.
  const context = {
    db:new pg.Pool({ connectionString:env.DATABASE.connectionString,ssl:false,max:2,connectionTimeoutMillis:10000,idleTimeoutMillis:1000 }),
    emissions:[]
  };
  async function flush() {
    for (const item of context.emissions.splice(0)) {
      await context.db.query('INSERT INTO nexora_private.events(audience,event,payload) VALUES($1,$2,$3::jsonb)',[item.audience,item.event,JSON.stringify(item.payload)]);
    }
  }
  return { ...api,db:context.db,port,flush,close:()=>context.db.end(),
    run(callback) { return scope.run(context, async () => { await api.initialize(); return callback(); }); }
  };
}
