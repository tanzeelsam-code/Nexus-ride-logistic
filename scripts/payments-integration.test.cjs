/* Runs only against an explicitly named isolated test database; Stripe is an in-process fake. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const Redis = require("ioredis");
const { createBackend } = require("../backend_api.js");

test(
  "card booking, capture, transfer, retries, ownership and concurrent cash bookings",
  { skip: process.env.NEXORA_TEST_DATABASE !== "isolated", timeout: 120000 },
  async (t) => {
    const db = new Pool({
      host: "127.0.0.1",
      port: Number(process.env.TEST_DB_PORT || 55439),
      user: "nexus",
      password: process.env.TEST_DB_PASSWORD || "nexora_isolated_test",
      database: "nexusdb",
    });
    const redis = new Redis({
      host: "127.0.0.1",
      port: Number(process.env.TEST_REDIS_PORT || 56389),
      password: process.env.TEST_REDIS_PASSWORD || "nexora_isolated_test",
    });
    await db.query(
      fs.readFileSync(
        "supabase/migrations/20261019085513_booking_payments_notifications.sql",
        "utf8",
      ),
    );
    await db.query(fs.readFileSync("supabase/migrations/20261024093153_release_recovery_cash_billing.sql", "utf8"));
    const intents = new Map(),
      transfers = [];
    let captures = 0,
      transferCreates = 0,
      failCapture = true;
    const stripe = {
      customers: { create: async () => ({ id: "cus_fixture" }) },
      paymentIntents: {
        create: async (body) => {
          const pi = {
            ...body,
            id: "pi_" + crypto.randomBytes(8).toString("hex"),
            client_secret: "fixture_secret",
            status: "requires_payment_method",
          };
          intents.set(pi.id, pi);
          return pi;
        },
        retrieve: async (id) => intents.get(id),
        capture: async (id) => {
          if (failCapture) {
            failCapture = false;
            throw Object.assign(new Error("Temporary provider failure"), {
              code: "provider_timeout",
            });
          }
          captures++;
          const pi = intents.get(id);
          Object.assign(pi, {
            status: "succeeded",
            amount_received: pi.amount,
            latest_charge: "ch_" + id,
          });
          return pi;
        },
        cancel: async (id) => {
          const pi = intents.get(id);
          pi.status = "canceled";
          return pi;
        },
      },
      accounts: {
        retrieve: async () => ({
          payouts_enabled: true,
          capabilities: { transfers: "active" },
        }),
      },
      transfers: {
        list: async ({ transfer_group }) => ({
          data: transfers.filter((t) => t.transfer_group === transfer_group),
        }),
        create: async (body) => {
          transferCreates++;
          const transfer = {
            ...body,
            id: "tr_" + crypto.randomBytes(8).toString("hex"),
          };
          transfers.push(transfer);
          return transfer;
        },
      },
      webhooks: require("stripe")("sk_test_fixture").webhooks,
    };
    const backend = createBackend({
      edge: true,
      db,
      redis,
      stripe,
      passwords: require("bcryptjs"),
      rateLimit: async () => {},
      io: {
        on() {},
        to() {
          return { emit() {} };
        },
        sockets: { adapter: { rooms: new Map() } },
      },
      fetch: async (url) => ({
        ok: true,
        json: async () =>
          String(url).includes("/directions/")
            ? {
                code: "Ok",
                routes: [
                  {
                    distance: 5000,
                    duration: 600,
                    geometry: {
                      type: "LineString",
                      coordinates: [
                        [67, 24.8],
                        [67.05, 24.85],
                      ],
                    },
                  },
                ],
              }
            : { features: [] },
      }),
      env: {
        NODE_ENV: "development",
        LOG_LEVEL: "silent",
        JWT_SECRET: "test-only-secret-more-than-32-characters",
        MAPBOX_API_KEY: "fixture",
        CARD_PAYMENTS_ENABLED: "true",
        STRIPE_SECRET_KEY: "sk_test_fixture",
        STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
      },
    });
    await backend.initialize();
    t.after(async () => {
      await backend.app.close();
      await redis.quit();
      await db.end();
    });
    async function call(method, url, body, token, headers = {}) {
      const r = await backend.app.inject({
        method,
        url: "/api/v1" + url,
        payload: body,
        headers: {
          ...(token ? { authorization: "Bearer " + token } : {}),
          ...headers,
        },
      });
      return { status: r.statusCode, body: r.json() };
    }
    async function register(role = "customer") {
      const suffix = crypto.randomBytes(6).toString("hex");
      const body = {
        email: `new-${suffix}@nexora.test`,
        phone: "+1555" + String(crypto.randomInt(1e9)).padStart(9, "0"),
        first_name: "Test",
        last_name: "User",
        password: "test-long-password",
      };
      if (role === "driver")
        body.vehicle = {
          plate_number: suffix,
          make: "Test",
          model: "Test",
          year: 2025,
          color: "Green",
          vehicle_type: "sedan",
        };
      const res = await call(
        "POST",
        role === "driver" ? "/drivers/register" : "/auth/register",
        body,
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body;
    }
    const rider = await register(),
      other = await register(),
      driver = await register("driver");
    const {
      rows: [d],
    } = await db.query(
      "UPDATE drivers SET onboarding_completed=TRUE,stripe_account_id=$2 WHERE user_id=$1 RETURNING id",
      [driver.user.id, "acct_" + crypto.randomBytes(4).toString("hex")],
    );
    await call(
      "POST",
      "/driver/location",
      { lat: 24.8, lng: 67 },
      driver.token,
    );
    await call("POST", "/driver/status", { status: "available" }, driver.token);
    const body = {
      pickup_lat: 24.8,
      pickup_lng: 67,
      pickup_address: "Pickup",
      dropoff_lat: 24.85,
      dropoff_lng: 67.05,
      dropoff_address: "Destination",
      service_type: "taxi",
      payment_method: "cash",
    };
    const q = await call("POST", "/trips/estimate", body);
    assert.equal(q.status, 200);
    assert.equal(q.body.price_estimate.total_fare, 11);
    assert.equal(
      (await call("GET", "/trips", undefined, q.body.quote_token)).status,
      401,
      "quote is not an access token",
    );
    assert.equal(
      (
        await call(
          "POST",
          "/trips",
          { ...body, dropoff_lat: 25, quote_token: q.body.quote_token },
          rider.token,
        )
      ).status,
      409,
      "changed route invalidates quote",
    );
    const a = await call(
      "POST",
      "/payments/authorize",
      { quote_token: q.body.quote_token },
      rider.token,
    );
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const pi = intents.get(a.body.payment_intent_id);
    pi.status = "requires_capture";
    pi.amount_capturable = pi.amount;
    const cardBody = {
      ...body,
      payment_method: "card",
      quote_token: q.body.quote_token,
      payment_intent_id: pi.id,
    };
    assert.equal(
      (await call("POST", "/trips", cardBody, other.token)).status,
      409,
      "another customer cannot consume an authorization",
    );
    pi.amount_capturable--;
    assert.equal(
      (await call("POST", "/trips", cardBody, rider.token)).status,
      409,
      "wrong amount rejected",
    );
    pi.amount_capturable++;
    let booked = await call("POST", "/trips", cardBody, rider.token, {
      "idempotency-key": "card-booking",
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    const tripId = booked.body.trip.id;
    const replay = await call("POST", "/trips", cardBody, rider.token, {
      "idempotency-key": "card-booking",
    });
    assert.equal(replay.body.trip.id, tripId);
    const path = "/driver/trips/" + tripId;
    for (const action of ["accept", "arrive"])
      assert.equal(
        (await call("POST", path + "/" + action, {}, driver.token)).status,
        200,
      );
    assert.equal(
      (
        await call(
          "POST",
          path + "/start",
          { otp: booked.body.trip.pickup_otp },
          driver.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("POST", path + "/complete", {}, driver.token)).status,
      200,
    );
    const completionRetry = await call(
      "POST",
      path + "/complete",
      {},
      driver.token,
    );
    assert.equal(completionRetry.status, 409);
    await backend.payments.sweep();
    assert.equal(captures, 0, "failed capture is retried");
    await db.query(
      "UPDATE background_jobs SET available_at=NOW() WHERE dedupe_key=$1",
      ["capture:" + tripId],
    );
    await backend.payments.sweep();
    assert.equal(captures, 1);
    assert.equal(transferCreates, 1);
    await backend.payments.recordCapture(pi);
    await backend.payments.handleJob({
      kind: "transfer",
      payload: { trip_id: tripId },
    });
    assert.equal(
      transferCreates,
      1,
      "webhook and completion retries do not double-pay",
    );
    const {
      rows: [totals],
    } = await db.query("SELECT pending_payout FROM drivers WHERE id=$1", [
      d.id,
    ]);
    assert.equal(Number(totals.pending_payout), 0);
    const {
      rows: [payment],
    } = await db.query("SELECT * FROM payments WHERE trip_id=$1", [tripId]);
    assert.equal(payment.status, "captured");
    assert.equal(Number(payment.amount), 11);
    const {
      rows: [settlement],
    } = await db.query("SELECT * FROM driver_settlements WHERE trip_id=$1", [
      tripId,
    ]);
    assert.equal(settlement.amount_cents, 880);
    // After provider success but a lost database response, reconciliation discovers the transfer even beyond the provider's key retention window.
    await db.query(
      "UPDATE driver_settlements SET transfer_id=NULL,transferred_at=NULL WHERE trip_id=$1",
      [tripId],
    );
    await backend.payments.handleJob({
      kind: "transfer",
      payload: { trip_id: tripId },
    });
    assert.equal(transferCreates, 1);
    const eventId = "evt_" + crypto.randomBytes(8).toString("hex");
    const eventPayload = JSON.stringify({
      id: eventId,
      type: "payment_intent.succeeded",
      data: { object: pi },
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: eventPayload,
      secret: "whsec_test",
    });
    const deliver = () =>
      backend.app.inject({
        method: "POST",
        url: "/api/v1/webhooks/stripe",
        payload: eventPayload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature,
        },
      });
    assert.equal((await deliver()).statusCode, 200);
    assert.equal((await deliver()).json().duplicate, true);
    const originalHandler = backend.payments.handleEvent;
    backend.payments.handleEvent = async () => {
      throw Object.assign(new Error("Transient processing failure"), {
        code: "test_retry",
      });
    };
    await backend.processBackground();
    const {
      rows: [retryJob],
    } = await db.query("SELECT * FROM background_jobs WHERE dedupe_key=$1", [
      "stripe:" + eventId,
    ]);
    assert.equal(retryJob.completed_at, null);
    assert.equal(retryJob.last_error, "test_retry");
    backend.payments.handleEvent = originalHandler;
    await db.query(
      "UPDATE background_jobs SET available_at=NOW() WHERE id=$1",
      [retryJob.id],
    );
    await backend.processBackground();
    const {
      rows: [processed],
    } = await db.query(
      "SELECT processed_at,delivery_attempt FROM stripe_webhook_events WHERE event_id=$1",
      [eventId],
    );
    assert.ok(processed.processed_at);
    assert.equal(processed.delivery_attempt, 2);
    assert.equal(transferCreates, 1);
    const concurrent = await Promise.all([
      call("POST", "/trips", body, other.token),
      call("POST", "/trips", body, other.token),
    ]);
    assert.deepEqual(
      concurrent.map((r) => r.status).sort(),
      [201, 409],
      "one active ride per customer under concurrency",
    );
    await call(
      "POST",
      "/trips/" +
        concurrent.find((r) => r.status === 201).body.trip.id +
        "/cancel",
      {},
      other.token,
    );
    const q2 = await call("POST", "/trips/estimate", body);
    const a2 = await call(
      "POST",
      "/payments/authorize",
      { quote_token: q2.body.quote_token },
      rider.token,
    );
    const pi2 = intents.get(a2.body.payment_intent_id);
    pi2.status = "requires_capture";
    pi2.amount_capturable = pi2.amount;
    const cancelled = await call(
      "POST",
      "/trips",
      {
        ...cardBody,
        quote_token: q2.body.quote_token,
        payment_intent_id: pi2.id,
      },
      rider.token,
    );
    assert.equal(cancelled.status, 201);
    await call(
      "POST",
      "/trips/" + cancelled.body.trip.id + "/cancel",
      {},
      rider.token,
    );
    await backend.payments.sweep();
    assert.equal(
      pi2.status,
      "canceled",
      "cancellation releases the authorization",
    );
    // Expired unused holds are also released and cannot be attached afterwards.
    const q3 = await call("POST", "/trips/estimate", body),
      a3 = await call(
        "POST",
        "/payments/authorize",
        { quote_token: q3.body.quote_token },
        rider.token,
      );
    const pi3 = intents.get(a3.body.payment_intent_id);
    pi3.status = "requires_capture";
    await db.query(
      "UPDATE booking_payments SET expires_at=NOW()-INTERVAL '1 minute' WHERE intent_id=$1",
      [pi3.id],
    );
    await backend.payments.sweep();
    assert.equal(pi3.status, "canceled");
    const expiredToken = backend.app.jwt.sign(
      { type: "ride_quote", fingerprint: "x", pricing: {} },
      { expiresIn: -1 },
    );
    assert.equal(
      (
        await call(
          "POST",
          "/payments/authorize",
          { quote_token: expiredToken },
          rider.token,
        )
      ).status,
      409,
    );
    // A refund received before capture reconciliation must not be overwritten or paid out.
    await db.query("DELETE FROM driver_settlements WHERE trip_id=$1", [tripId]);
    await backend.payments.handleEvent({
      type: "charge.refunded",
      data: { object: { id: pi.latest_charge, payment_intent: pi.id } },
    });
    await backend.payments.recordCapture(pi);
    const {
      rows: [refunded],
    } = await db.query("SELECT payment_status FROM trips WHERE id=$1", [
      tripId,
    ]);
    assert.equal(refunded.payment_status, "refunded");
    assert.equal(
      (
        await db.query("SELECT * FROM driver_settlements WHERE trip_id=$1", [
          tripId,
        ])
      ).rowCount,
      0,
    );
  },
);
