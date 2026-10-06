#!/usr/bin/env node
/**
 * NEXUS end-to-end test.
 *
 * Boots the API and drives the real ride + freight flows over HTTP and Socket.io:
 * auth, driver onboarding and approval, dispatch, the trip and delivery lifecycles,
 * idempotency, RBAC, cold chain, Stripe webhooks and the ops socket.
 *
 * Needs PostgreSQL (with database_schema.sql loaded) and Redis. Configure with
 * DB_HOST / DB_PORT / DB_PASSWORD / REDIS_HOST / REDIS_PORT / REDIS_PASSWORD, as for the API.
 *
 *   node scripts/e2e.js            # spawns the API on E2E_PORT (default 3097)
 *   E2E_BASE_URL=http://host:3000 node scripts/e2e.js   # use an already running API
 *                                                        # (needs ADMIN_* / IOT_DEVICE_KEY below)
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.E2E_PORT || 3097);
const BASE = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;
const API = `${BASE}/api/v1`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'e2e-admin@nexus.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'e2e-admin-password-123';
const DEVICE_KEY = process.env.IOT_DEVICE_KEY || 'e2e-device-key';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_e2e';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ❌ ${name}${detail !== undefined ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const get = (p, o) => http('GET', `${API}${p}`, o);
const post = (p, body, o = {}) => http('POST', `${API}${p}`, { ...o, body: body ?? {} });

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 400 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

function unique() { return crypto.randomBytes(4).toString('hex'); }
function phone() { return `+1555${String(crypto.randomInt(0, 1e7)).padStart(7, '0')}`; }

async function registerCustomer(tag) {
  const email = `cust-${tag}-${unique()}@nexus.test`;
  const res = await post('/auth/register', {
    email, phone: phone(), first_name: 'Test', last_name: 'Rider', password: 'Rider-pass-123',
  });
  return { email, password: 'Rider-pass-123', ...res };
}

async function registerDriver(tag, mode = 'both') {
  const email = `drv-${tag}-${unique()}@nexus.test`;
  const res = await post('/drivers/register', {
    email, phone: phone(), first_name: 'Test', last_name: 'Driver', password: 'Driver-pass-123', mode,
    vehicle: { plate_number: `E2E-${unique()}`.toUpperCase(), make: 'Toyota', model: 'Camry', year: 2022, color: 'Black', vehicle_type: 'sedan' },
  });
  return { email, ...res };
}

const PICKUP = { lat: 40.7580, lng: -73.9855 };
const DROPOFF = { lat: 40.6413, lng: -73.7781 };

const tripBody = () => ({
  pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, pickup_address: '5th Ave & 42nd St',
  dropoff_lat: DROPOFF.lat, dropoff_lng: DROPOFF.lng, dropoff_address: 'JFK Airport',
  service_type: 'taxi', payment_method: 'cash',
});

const deliveryBody = (extra = {}) => ({
  pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, pickup_address: 'Depot A',
  pickup_contact_name: 'Sender', pickup_contact_phone: '+15550000001',
  dropoff_lat: 40.7484, dropoff_lng: -73.9857, dropoff_address: 'Office B',
  dropoff_contact_name: 'Receiver', dropoff_contact_phone: '+15550000002',
  cargo_description: 'Documents', cargo_weight_kg: 3, ...extra,
});

// Leftover drivers from earlier runs would be matched by dispatch and make the run non-deterministic.
async function isolateFromPreviousRuns() {
  const { Pool } = require('pg');
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'nexusdb',
    user: process.env.DB_USER || 'nexus',
    password: process.env.DB_PASSWORD || 'nexus_secret',
  });
  try {
    await pool.query("UPDATE drivers SET is_online = FALSE, status = 'offline' WHERE status <> 'suspended'");
    await pool.query("UPDATE trips SET status = 'cancelled' WHERE status IN ('requested','searching','accepted','driver_en_route','arrived','in_progress')");
    await pool.query("UPDATE deliveries SET status = 'cancelled' WHERE status IN ('pending','pickup_scheduled','in_transit','out_for_delivery')");
  } finally {
    await pool.end();
  }
}

async function run() {
  await isolateFromPreviousRuns();
  console.log('\n── Health ─────────────────────────────────────────');
  let r = await get('/health');
  check('GET /health is ok', r.status === 200 && r.body.status === 'ok', r);
  r = await get('/ready');
  check('GET /ready reports database and redis up', r.status === 200 && r.body.checks.database === 'up' && r.body.checks.redis === 'up', r.body);
  r = await get('/metrics');
  check('GET /metrics serves prometheus text', r.status === 200 && String(r.body).includes('nexus_requests_total'));

  console.log('\n── Auth ───────────────────────────────────────────');
  const cust = await registerCustomer('main');
  check('customer registers (201)', cust.status === 201 && cust.body.token && cust.body.refresh_token, cust.body);
  const dup = await post('/auth/register', { email: cust.email, phone: phone(), first_name: 'A', last_name: 'B', password: 'Rider-pass-123' });
  check('duplicate email is rejected (409)', dup.status === 409, dup);
  const upper = await post('/auth/register', { email: cust.email.toUpperCase(), phone: phone(), first_name: 'A', last_name: 'B', password: 'Rider-pass-123' });
  check('email matching is case-insensitive (409)', upper.status === 409, upper);
  r = await post('/auth/register', { email: 'not-an-email', phone: '1', first_name: '', last_name: '', password: 'x' });
  check('invalid registration payload is rejected (400)', r.status === 400, r);

  r = await post('/auth/login', { email: cust.email, password: 'wrong-password' });
  check('wrong password -> 401', r.status === 401, r);
  r = await post('/auth/login', { email: cust.email, password: cust.password });
  check('login succeeds', r.status === 200 && r.body.token, r);
  let custToken = r.body.token;
  const refresh1 = r.body.refresh_token;

  r = await get('/trips', { token: refresh1 });
  check('a refresh token cannot be used as an access token', r.status === 401, r);

  r = await post('/auth/refresh', { refresh_token: refresh1 });
  check('refresh issues new tokens', r.status === 200 && r.body.token && r.body.refresh_token, r);
  custToken = r.body.token;
  const refresh2 = r.body.refresh_token;
  r = await post('/auth/refresh', { refresh_token: refresh1 });
  check('rotated refresh token cannot be replayed (401)', r.status === 401, r);

  r = await post('/auth/logout', { refresh_token: refresh2 }, { token: custToken });
  check('logout succeeds', r.status === 200, r);
  r = await get('/trips', { token: custToken });
  check('revoked access token is rejected', r.status === 401, r);
  r = await post('/auth/refresh', { refresh_token: refresh2 });
  check('refresh token is revoked on logout', r.status === 401, r);
  r = await post('/auth/login', { email: cust.email, password: cust.password });
  custToken = r.body.token;

  r = await get('/trips');
  check('protected route without a token -> 401', r.status === 401);

  console.log('\n── Pricing ────────────────────────────────────────');
  r = await post('/trips/estimate', tripBody());
  check('trip estimate works without the AI engine', r.status === 200 && r.body.price_estimate.total_fare > 5, r);
  r = await post('/trips/estimate', { ...tripBody(), pickup_lat: 999 });
  check('out-of-range coordinates are rejected (400)', r.status === 400, r);
  r = await post('/b2b/quote', { pickup_lat: 40.7, pickup_lng: -74, dropoff_lat: 40.75, dropoff_lng: -73.98, service_type: 'cold_chain', cargo_weight_kg: 85, cargo_value: 5000, insurance_requested: true });
  check('B2B freight quote includes a cold-chain surcharge and insurance', r.status === 200 && r.body.breakdown.cold_chain_surcharge > 0 && r.body.breakdown.insurance_premium === 75, r.body);

  console.log('\n── RBAC ───────────────────────────────────────────');
  r = await post('/driver/status', { status: 'available' }, { token: custToken });
  check('customer cannot use driver endpoints (403)', r.status === 403, r);
  r = await post('/driver/location', { lat: 1, lng: 1 }, { token: custToken });
  check('customer cannot post driver location (403)', r.status === 403, r);
  r = await get('/ops/overview', { token: custToken });
  check('customer cannot read ops overview (403)', r.status === 403, r);
  r = await get('/ops/overview');
  check('anonymous cannot read ops overview (401)', r.status === 401, r);
  r = await get('/fleet/drivers');
  check('anonymous cannot read the fleet (401)', r.status === 401, r);
  r = await get('/admin/dashboard', { token: custToken });
  check('customer cannot read admin dashboard (403)', r.status === 403, r);
  r = await post('/cold-chain/telemetry', { delivery_id: 'X', temperature_c: 5 });
  check('anonymous cannot post cold-chain telemetry (401)', r.status === 401, r);

  console.log('\n── Driver onboarding ──────────────────────────────');
  r = await post('/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  check('bootstrapped admin can log in', r.status === 200 && r.body.user.role === 'admin', r);
  const adminToken = r.body.token;

  const drvA = await registerDriver('a', 'both');
  check('driver registers (201), not yet approved', drvA.status === 201 && drvA.body.driver.approved === false, drvA.body);
  const drvAToken = drvA.body.token;
  const drvAId = drvA.body.driver.id;
  r = await post('/driver/status', { status: 'available' }, { token: drvAToken });
  check('unapproved driver cannot go online (403)', r.status === 403 && r.body.code === 'pending_approval', r);
  r = await get('/admin/drivers?status=pending', { token: adminToken });
  check('admin sees the driver in the approval queue', r.status === 200 && r.body.drivers.some((d) => d.id === drvAId), r.body);
  r = await post(`/admin/drivers/${drvAId}/approve`, {}, { token: adminToken });
  check('admin approves the driver', r.status === 200, r);
  r = await post('/driver/status', { status: 'bogus' }, { token: drvAToken });
  check('invalid driver status is rejected (400)', r.status === 400, r);
  r = await post('/driver/status', { status: 'available' }, { token: drvAToken });
  check('approved driver goes online', r.status === 200, r);
  r = await post('/driver/location', { lat: 40.7585, lng: -73.9850, heading: 90, speed_kmh: 0, battery_pct: 90 }, { token: drvAToken });
  check('driver posts a location', r.status === 200, r);
  r = await post('/driver/location', { lat: 'north', lng: 0 }, { token: drvAToken });
  check('bad location payload is rejected (400)', r.status === 400, r);

  console.log('\n── Ride: request → dispatch → complete ────────────');
  const idemKey = `e2e-${unique()}-trip`;
  r = await post('/trips', tripBody(), { token: custToken, headers: { 'idempotency-key': idemKey } });
  check('trip is created (201) with a rider OTP', r.status === 201 && r.body.trip.pickup_otp && r.body.trip.id, r.body);
  const trip = r.body.trip;
  const replay = await post('/trips', tripBody(), { token: custToken, headers: { 'idempotency-key': idemKey } });
  check('same idempotency key replays the original response', replay.status === 201 && replay.body.trip.id === trip.id && replay.headers.get('x-idempotent-replay') === 'true', replay.body);
  r = await post('/trips', { ...tripBody(), dropoff_address: 'Elsewhere' }, { token: custToken, headers: { 'idempotency-key': idemKey } });
  check('same key with a different payload -> 409', r.status === 409, r);
  r = await post('/trips', tripBody(), { token: custToken });
  check('a rider cannot hold two open trips (409)', r.status === 409, r);

  const offered = await waitFor(async () => {
    const t = await get(`/trips/${trip.id}`, { token: custToken });
    return t.body.trip?.status === 'accepted' && t.body.trip.driver_id === drvAId ? t.body.trip : null;
  });
  check('dispatch offers the trip to the nearby driver', !!offered);
  check('rider sees the driver and their own pickup OTP', !!(offered && offered.driver_name && offered.pickup_otp === trip.pickup_otp), offered && offered.driver_name);

  r = await get('/driver/jobs/current', { token: drvAToken });
  check('driver sees the offer in current jobs', r.status === 200 && r.body.trips.some((t) => t.id === trip.id), r.body);

  const drvB = await registerDriver('b', 'ride');
  r = await post(`/driver/trips/${trip.id}/accept`, {}, { token: drvB.body.token });
  check('a different driver cannot touch the trip (404)', r.status === 404, r);
  r = await post(`/driver/trips/${trip.id}/start`, { otp: '0000' }, { token: drvAToken });
  check('cannot skip states: start before accept (409)', r.status === 409, r);

  r = await post(`/driver/trips/${trip.id}/accept`, {}, { token: drvAToken });
  check('driver accepts', r.status === 200 && r.body.status === 'driver_en_route', r);
  r = await post(`/driver/trips/${trip.id}/accept`, {}, { token: drvAToken });
  check('accepting twice is rejected (409)', r.status === 409, r);
  r = await post(`/driver/trips/${trip.id}/arrive`, {}, { token: drvAToken });
  check('driver arrives', r.status === 200 && r.body.status === 'arrived', r);
  r = await post(`/driver/trips/${trip.id}/start`, { otp: '0000' === trip.pickup_otp ? '1111' : '0000' }, { token: drvAToken });
  check('wrong rider OTP is rejected (403)', r.status === 403, r);
  r = await post(`/driver/trips/${trip.id}/start`, { otp: trip.pickup_otp }, { token: drvAToken });
  check('correct OTP starts the trip', r.status === 200 && r.body.status === 'in_progress', r);
  r = await post(`/trips/${trip.id}/cancel`, {}, { token: custToken });
  check('cannot cancel a trip in progress (400)', r.status === 400, r);
  r = await post(`/driver/trips/${trip.id}/complete`, { actual_distance_km: 21.4 }, { token: drvAToken });
  check('driver completes; 80/20 split computed', r.status === 200 && r.body.status === 'completed' && Math.abs(r.body.driver_earnings + r.body.platform_fee - r.body.fare) < 0.011 && r.body.platform_fee > 0, r.body);

  r = await post(`/trips/${trip.id}/rate`, { rating: 7 }, { token: custToken });
  check('rating out of range is rejected (400)', r.status === 400, r);
  r = await post(`/trips/${trip.id}/rate`, { rating: 5, review: 'Great' }, { token: custToken });
  check('rider rates the trip', r.status === 200, r);
  r = await post(`/trips/${trip.id}/rate`, { rating: 1 }, { token: custToken });
  check('a trip cannot be rated twice (404)', r.status === 404, r);

  r = await get('/driver/earnings?period=today', { token: drvAToken });
  check('driver earnings reflect the completed trip', r.status === 200 && Number(r.body.earnings.completed_trips) === 1 && Number(r.body.earnings.total_earnings) > 0, r.body);
  r = await get('/admin/drivers', { token: adminToken });
  const driverRow = r.body.drivers?.find((d) => d.id === drvAId);
  check('driver is available again after the trip', driverRow && driverRow.status === 'available', driverRow);

  r = await get('/trips?status=completed', { token: custToken });
  check('trip history lists the completed trip', r.status === 200 && r.body.trips.length === 1, r.body);
  r = await get("/trips?status=x';DROP TABLE trips;--", { token: custToken });
  check('malformed status filter is rejected (400)', r.status === 400, r);
  r = await get(`/trips/${trip.id}`, { token: (await registerCustomer('other')).body.token });
  check("another rider cannot read someone else's trip (404)", r.status === 404, r);
  r = await get('/trips/not-a-uuid', { token: custToken });
  check('malformed trip id is a 404, not a 500', r.status === 404, r);

  console.log('\n── Ride: decline, timeout, cancel, no driver ──────');
  // Second rider; only driver A is online/available, so a decline leaves the trip searching.
  const cust2 = await registerCustomer('two');
  r = await post('/trips', tripBody(), { token: cust2.body.token });
  const trip2 = r.body.trip;
  await waitFor(async () => (await get(`/trips/${trip2.id}`, { token: cust2.body.token })).body.trip?.status === 'accepted');
  r = await post(`/driver/trips/${trip2.id}/decline`, {}, { token: drvAToken });
  check('driver declines the offer', r.status === 200, r);
  r = await get(`/trips/${trip2.id}`, { token: cust2.body.token });
  check('declined trip returns to searching with no driver', r.body.trip.status === 'searching' && r.body.trip.driver_id === null, r.body.trip);

  // Bring a second driver online; the declined driver must be excluded and driver B gets the offer.
  await post(`/admin/drivers/${drvB.body.driver.id}/approve`, {}, { token: adminToken });
  await post('/driver/status', { status: 'available' }, { token: drvB.body.token });
  await post('/driver/location', { lat: 40.7590, lng: -73.9860 }, { token: drvB.body.token });
  const reoffered = await waitFor(async () => {
    const t = await get(`/trips/${trip2.id}`, { token: cust2.body.token });
    return t.body.trip?.status === 'accepted' && t.body.trip.driver_id === drvB.body.driver.id;
  });
  check('retry offers the trip to a different driver (decliner excluded)', !!reoffered);

  // Driver B ignores the offer: the sweeper must time it out and release the driver.
  const timedOut = await waitFor(async () => {
    const t = await get(`/trips/${trip2.id}`, { token: cust2.body.token });
    return t.body.trip?.status === 'searching' && t.body.trip.driver_id === null;
  }, { timeoutMs: 20000 });
  check('an unanswered offer times out and the trip is re-queued', !!timedOut, (await get(`/trips/${trip2.id}`, { token: cust2.body.token })).body.trip?.status);
  r = await post(`/trips/${trip2.id}/cancel`, { reason: 'changed my mind' }, { token: cust2.body.token });
  check('rider cancels while searching (no fee)', r.status === 200 && r.body.cancellation_fee === 0, r);

  const cust3 = await registerCustomer('three');
  r = await post('/trips', { ...tripBody(), pickup_lat: -33.86, pickup_lng: 151.2, dropoff_lat: -33.9, dropoff_lng: 151.25 }, { token: cust3.body.token });
  const far = r.body.trip;
  const failedTrip = await waitFor(async () => (await get(`/trips/${far.id}`, { token: cust3.body.token })).body.trip?.status === 'failed', { timeoutMs: 40000 });
  check('with no driver in range the trip fails cleanly after the dispatch timeout', !!failedTrip);

  console.log('\n── Freight: delivery lifecycle ────────────────────');
  await post('/driver/status', { status: 'offline' }, { token: drvB.body.token });
  r = await post('/deliveries', { pickup_lat: 1 }, { token: custToken });
  check('incomplete delivery payload is rejected (400)', r.status === 400, r);
  r = await post('/deliveries', deliveryBody({ insurance_requested: true, cargo_value: 1000 }), { token: custToken, headers: { 'idempotency-key': `e2e-${unique()}-del` } });
  check('delivery is created with pickup and drop-off OTPs', r.status === 201 && /^\d{6}$/.test(r.body.delivery.pickup_otp) && /^\d{6}$/.test(r.body.delivery.dropoff_otp), r.body);
  const del = r.body.delivery;
  check('insurance premium is 1.5% of declared value', del.insurance_premium === 15, del);
  const slug = del.tracking_url.split('/').pop();

  const delOffered = await waitFor(async () => {
    const j = await get('/driver/jobs/current', { token: drvAToken });
    return j.body.deliveries?.find((d) => d.id === del.id);
  });
  check('delivery is offered to a freight-capable driver', !!delOffered);
  r = await post(`/driver/deliveries/${del.id}/pickup`, { otp: del.pickup_otp }, { token: drvAToken });
  check('cannot pick up before accepting (409)', r.status === 409, r);
  r = await post(`/driver/deliveries/${del.id}/accept`, {}, { token: drvAToken });
  check('driver accepts the delivery', r.status === 200 && r.body.status === 'pickup_scheduled', r);
  r = await post(`/driver/deliveries/${del.id}/pickup`, { otp: '000000' === del.pickup_otp ? '111111' : '000000' }, { token: drvAToken });
  check('wrong pickup OTP is rejected (403)', r.status === 403, r);
  r = await post(`/driver/deliveries/${del.id}/pickup`, { otp: del.pickup_otp }, { token: drvAToken });
  check('pickup OTP moves the delivery in transit', r.status === 200 && r.body.status === 'in_transit', r);
  r = await post('/driver/location', { lat: 40.753, lng: -73.985 }, { token: drvAToken });
  r = await get(`/track/${slug}`);
  check('public tracking shows live position', r.status === 200 && Number(r.body.delivery.current_lat) === 40.753 && r.body.delivery.status === 'in_transit', r.body);
  check('public tracking never leaks OTPs', !JSON.stringify(r.body).match(/otp/i));
  r = await get('/track/' + 'f'.repeat(24));
  check('unknown tracking slug -> 404', r.status === 404);
  r = await post(`/driver/deliveries/${del.id}/deliver`, { otp: del.pickup_otp }, { token: drvAToken });
  check('drop-off requires the drop-off OTP, not the pickup OTP (403)', r.status === 403, r);
  r = await post(`/driver/deliveries/${del.id}/deliver`, { otp: del.dropoff_otp }, { token: drvAToken });
  check('delivery is completed with earnings', r.status === 200 && r.body.status === 'delivered' && r.body.driver_earnings > 0, r);
  r = await get(`/deliveries/${del.id}`, { token: custToken });
  check('customer sees the delivered status and keeps their OTPs', r.status === 200 && r.body.delivery.status === 'delivered' && r.body.delivery.dropoff_otp, r.body);

  console.log('\n── Cold chain ─────────────────────────────────────');
  r = await post('/deliveries', deliveryBody({ requires_refrigeration: true, temp_min_celsius: 2, temp_max_celsius: 8, cargo_description: 'Vaccines', cargo_weight_kg: 20 }), { token: custToken });
  const cold = r.body.delivery;
  check('refrigerated delivery created', r.status === 201, r.body);
  await waitFor(async () => (await get('/driver/jobs/current', { token: drvAToken })).body.deliveries?.find((d) => d.id === cold.id));
  await post(`/driver/deliveries/${cold.id}/accept`, {}, { token: drvAToken });
  r = await post('/cold-chain/telemetry', { delivery_id: cold.delivery_number, temperature_c: 4.5 }, { headers: { 'x-device-key': DEVICE_KEY } });
  check('in-range reading is logged, no alert', r.status === 200 && r.body.is_excursion === false, r);
  r = await post('/cold-chain/telemetry', { delivery_id: cold.delivery_number, temperature_c: 14.2, battery_pct: 70 }, { headers: { 'x-device-key': DEVICE_KEY } });
  check('out-of-range reading raises a critical alert', r.status === 200 && r.body.is_excursion && r.body.severity === 'critical', r);
  r = await post('/cold-chain/telemetry', { delivery_id: cold.delivery_number, temperature_c: 4 }, { headers: { 'x-device-key': 'wrong' } });
  check('wrong device key is rejected', r.status === 401, r);
  r = await post('/cold-chain/telemetry', { delivery_id: 'DEL-DOES-NOT-EXIST', temperature_c: 4 }, { token: adminToken });
  check('telemetry for an unknown delivery -> 404', r.status === 404, r);
  r = await get('/cold-chain/shipments', { token: adminToken });
  const shipment = r.body.shipments?.find((s) => s.id === cold.delivery_number);
  check('ops sees the shipment and its excursion', r.status === 200 && shipment && shipment.status === 'WARNING' && Number(shipment.temp_alerts_count) === 1, r.body);
  r = await post(`/deliveries/${cold.id}/cancel`, {}, { token: custToken });
  check('customer cancels a delivery that has not been picked up', r.status === 200, r);

  console.log('\n── Ops & admin ────────────────────────────────────');
  r = await get('/ops/overview', { token: adminToken });
  check('ops overview returns real numbers', r.status === 200 && r.body.demo === false && r.body.metrics.completed_today >= 2 && r.body.metrics.today_revenue > 0, r.body.metrics);
  r = await get('/fleet/drivers', { token: adminToken });
  check('fleet lists real drivers', r.status === 200 && r.body.demo === false && r.body.drivers.some((d) => d.id === drvAId && d.mode === 'both'), r.body.counts);
  r = await post('/fleet/rebalance', {}, { token: adminToken });
  check('fleet rebalance runs', r.status === 200 && r.body.mode, r);
  r = await get('/admin/dashboard', { token: adminToken });
  check('admin dashboard aggregates today', r.status === 200 && Number(r.body.trips.completed) >= 1, r.body);
  r = await post('/driver/mode', { mode: 'freight' }, { token: drvAToken });
  check('driver switches operating mode', r.status === 200 && r.body.mode === 'freight', r);

  console.log('\n── Stripe webhook ─────────────────────────────────');
  const Stripe = require('stripe');
  const stripe = Stripe('sk_test_e2e');
  const payload = JSON.stringify({ id: `evt_${unique()}`, object: 'event', type: 'payment_intent.succeeded', data: { object: { id: 'pi_e2e' } } });
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  r = await http('POST', `${API}/webhooks/stripe`, { body: payload, headers: { 'stripe-signature': sig } });
  check('validly signed webhook is accepted', r.status === 200 && r.body.received === true, r);
  r = await http('POST', `${API}/webhooks/stripe`, { body: payload, headers: { 'stripe-signature': sig } });
  check('replayed webhook is acknowledged as a duplicate', r.status === 200 && r.body.duplicate === true, r);
  r = await http('POST', `${API}/webhooks/stripe`, { body: payload.replace('pi_e2e', 'pi_evil'), headers: { 'stripe-signature': sig } });
  check('tampered webhook body is rejected (400)', r.status === 400, r);
  r = await http('POST', `${API}/webhooks/stripe`, { body: payload });
  check('missing signature is rejected (400)', r.status === 400, r);

  console.log('\n── Realtime (Socket.io) ───────────────────────────');
  const { io: ioClient } = require('socket.io-client');
  const connect = () => new Promise((resolve, reject) => {
    const s = ioClient(BASE, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
  const once = (s, ev, ms = 3000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.once(ev, (d) => { clearTimeout(t); resolve(d || true); });
  });

  const anon = await connect();
  const anonJoin = once(anon, 'ops:joined');
  const anonErr = once(anon, 'ops:error');
  anon.emit('ops:join', {});
  check('anonymous socket cannot join the ops stream', (await anonErr) && !(await anonJoin));
  anon.close();

  const opsSock = await connect();
  const joined = once(opsSock, 'ops:joined');
  opsSock.emit('ops:join', { token: adminToken });
  check('admin socket joins the ops stream', !!(await joined));
  opsSock.close();

  const rider = await connect();
  const authOk = once(rider, 'auth:success');
  rider.emit('auth', { token: custToken });
  check('rider socket authenticates', !!(await authOk));
  const badAuth = await connect();
  const authErr = once(badAuth, 'auth:error');
  badAuth.emit('auth', { token: refresh2 });
  check('a refresh token cannot authenticate a socket', !!(await authErr));
  badAuth.close();

  // Live events: rider receives driver lifecycle events for a fresh trip.
  const events = [];
  for (const ev of ['trip:driver_offered', 'trip:driver_en_route', 'trip:driver_arrived', 'trip:started', 'trip:completed']) {
    rider.on(ev, () => events.push(ev));
  }
  const drvSock = await connect();
  const drvAuth = once(drvSock, 'auth:success');
  drvSock.emit('auth', { token: drvAToken });
  await drvAuth;
  await post('/driver/mode', { mode: 'ride' }, { token: drvAToken });
  await post('/driver/status', { status: 'available' }, { token: drvAToken });
  await post('/driver/location', { lat: 40.7585, lng: -73.985 }, { token: drvAToken });
  const newOffer = once(drvSock, 'trip:new_request', 8000);
  r = await post('/trips', tripBody(), { token: custToken });
  const liveTrip = r.body.trip;
  const offer = await newOffer;
  check('driver socket receives the new trip request', offer && offer.trip_id === liveTrip.id, offer);
  const ack = (ev, payload) => new Promise((resolve) => drvSock.emit(ev, payload, resolve));
  check('socket accept goes through the state machine', (await ack('trip:accept', { tripId: liveTrip.id })).code === 200);
  check('socket cannot skip straight to complete', (await ack('trip:complete', { tripId: liveTrip.id })).code === 409);
  await ack('trip:arrive', { tripId: liveTrip.id });
  await ack('trip:start', { tripId: liveTrip.id, otp: liveTrip.pickup_otp });
  await ack('trip:complete', { tripId: liveTrip.id, actual_distance_km: 20 });
  await sleep(500);
  check('rider receives the full event sequence', ['trip:driver_offered', 'trip:driver_en_route', 'trip:driver_arrived', 'trip:started', 'trip:completed'].every((e) => events.includes(e)), events);
  rider.close();
  drvSock.close();

  console.log('\n── Metrics ────────────────────────────────────────');
  r = await get('/metrics');
  check('metrics count requests and auth failures', /nexus_requests_total [1-9]/.test(r.body) && /nexus_auth_failures_total [1-9]/.test(r.body));
}

async function main() {
  let child = null;
  if (!process.env.E2E_BASE_URL) {
    const env = {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'development',
      OPS_AUTH_REQUIRED: 'true',
      ADMIN_EMAIL, ADMIN_PASSWORD,
      IOT_DEVICE_KEY: DEVICE_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      AI_ENGINE_URL: process.env.AI_ENGINE_URL || 'http://127.0.0.1:9',   // unreachable on purpose: exercises fallbacks
      DRIVER_RESPONSE_TIMEOUT_SEC: '4',
      DISPATCH_TIMEOUT_SEC: '14',
      DISPATCH_SWEEP_MS: '1000',
      LOG_LEVEL: 'warn',
    };
    child = spawn('node', [path.join(__dirname, '..', 'backend_api.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { if (process.env.E2E_VERBOSE) process.stderr.write(d); });
  }

  try {
    const up = await waitFor(async () => {
      try { return (await get('/health')).status === 200; } catch { return false; }
    }, { timeoutMs: 20000 });
    if (!up) throw new Error(`API did not start on ${BASE}`);
    await run();
  } catch (err) {
    failed += 1;
    failures.push(`crash: ${err.message}`);
    console.error('\nE2E crashed:', err);
  } finally {
    if (child) child.kill('SIGKILL');
  }

  console.log(`\n════════════════════════════════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) failures.forEach((f) => console.log(`   - ${f}`));
  console.log(`════════════════════════════════════════════════════\n`);
  process.exit(failed ? 1 : 0);
}

main();
