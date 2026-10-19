const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMaps, bookingFingerprint } = require("../services/maps.cjs");
const { validSubscription } = require("../services/notifications.cjs");
const { createJobs } = require("../services/jobs.cjs");
const webPush = require("web-push");

test("geocodes request permanent storage and preserve server-side credentials", async () => {
  let request;
  const maps = createMaps({
    token: "server-token",
    fetch: async (url) => {
      request = url;
      return {
        ok: true,
        json: async () => ({
          features: [
            {
              id: "address",
              properties: { full_address: "10 Main Street" },
              geometry: { coordinates: [-74, 40] },
            },
          ],
        }),
      };
    },
  });
  assert.deepEqual(await maps.search("Main Street"), [
    { id: "address", address: "10 Main Street", lat: 40, lng: -74 },
  ]);
  assert.equal(request.searchParams.get("permanent"), "true");
  assert.equal(request.searchParams.get("access_token"), "server-token");
});
test("road routes use provider geometry and duration rather than a distance multiplier", async () => {
  const geometry = {
    type: "LineString",
    coordinates: [
      [-74, 40],
      [-73, 41],
    ],
  };
  const maps = createMaps({
    token: "test",
    fetch: async () => ({
      ok: true,
      json: async () => ({
        code: "Ok",
        routes: [{ distance: 1500, duration: 900, geometry }],
      }),
    }),
  });
  const route = await maps.route({
    pickup_lat: 40,
    pickup_lng: -74,
    dropoff_lat: 41,
    dropoff_lng: -73,
  });
  assert.equal(route.distance_km, 1.5);
  assert.equal(route.duration_minutes, 15);
  assert.deepEqual(route.geometry, geometry);
});
test("production does not silently quote approximate routes when maps are unconfigured or failing", async () => {
  await assert.rejects(createMaps({}).route({}), { statusCode: 503 });
  await assert.rejects(
    createMaps({
      token: "x",
      fetch: async () => ({ ok: false, status: 401 }),
    }).route({}),
    { statusCode: 503 },
  );
  await assert.rejects(
    createMaps({
      token: "x",
      fetch: async () => ({
        ok: true,
        json: async () => ({ code: "NoRoute" }),
      }),
    }).route({}),
    { statusCode: 422 },
  );
});
test("quotes bind both stops and passenger count, independently of payment method", () => {
  const body = {
    pickup_lat: 1,
    pickup_lng: 2,
    pickup_address: "A",
    dropoff_lat: 3,
    dropoff_lng: 4,
    dropoff_address: "B",
    passengers: 1,
  };
  assert.notEqual(
    bookingFingerprint(body),
    bookingFingerprint({ ...body, dropoff_lat: 5 }),
  );
  assert.notEqual(
    bookingFingerprint(body),
    bookingFingerprint({ ...body, passengers: 2 }),
  );
  assert.equal(
    bookingFingerprint(body),
    bookingFingerprint({ ...body, payment_method: "card" }),
  );
});
test("push subscriptions cannot target arbitrary URLs, private networks or credential-bearing endpoints", () => {
  const keys = { p256dh: "a".repeat(87), auth: "b".repeat(22) };
  assert.equal(
    validSubscription({
      endpoint: "https://fcm.googleapis.com/send/abc",
      keys,
    }),
    true,
  );
  for (const endpoint of [
    "http://fcm.googleapis.com/send/abc",
    "https://localhost/push",
    "https://169.254.169.254/",
    "https://fcm.googleapis.com.attacker.test",
    "https://user:pass@fcm.googleapis.com/send/abc",
    "https://fcm.googleapis.com:444/push",
  ])
    assert.equal(validSubscription({ endpoint, keys }), false);
});
test("push payload encryption produces a fetch-compatible request without sending it", () => {
  const vapid = webPush.generateVAPIDKeys();
  const receiver = require("node:crypto").createECDH("prime256v1");
  receiver.generateKeys();
  const subscription = {
    endpoint: "https://fcm.googleapis.com/send/test",
    keys: {
      p256dh: receiver.getPublicKey().toString("base64url"),
      auth: require("node:crypto").randomBytes(16).toString("base64url"),
    },
  };
  const request = webPush.generateRequestDetails(
    subscription,
    JSON.stringify({ title: "A ride is waiting" }),
    {
      vapidDetails: {
        subject: "mailto:test@example.com",
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      },
    },
  );
  assert.ok(request.body.length > 0);
  assert.match(request.headers.Authorization, /vapid/);
});
test("failed jobs retain a retry and store a code rather than sensitive provider text", async () => {
  const calls = [];
  let claimed = false;
  const jobs = createJobs(async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("RETURNING *") && !claimed) {
      claimed = true;
      return { rows: [{ id: 1, kind: "capture", attempts: 1 }] };
    }
    return { rows: [] };
  });
  await jobs.run(["capture"], async () => {
    throw Object.assign(new Error("secret URL"), { code: "provider_timeout" });
  });
  const retry = calls.find((c) => c.sql.includes("last_error=$2"));
  assert.equal(retry.params[1], "provider_timeout");
  assert.equal(retry.params[2], 20);
  assert.ok(!calls.some((c) => c.sql.includes("completed_at=NOW()")));
});
