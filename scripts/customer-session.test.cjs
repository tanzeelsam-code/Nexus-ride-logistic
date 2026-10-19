const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
function setup(fetch) {
  const values = new Map([
    ["test_token", "old"],
    ["test_refresh", "refresh"],
  ]);
  let expired = 0;
  const context = {
    window: {},
    sessionStorage: {
      getItem: (k) => values.get(k) || null,
      setItem: (k, v) => values.set(k, v),
      removeItem: (k) => values.delete(k),
    },
    fetch,
    AbortSignal,
  };
  vm.runInNewContext(fs.readFileSync("frontend/session.js", "utf8"), context);
  return {
    session: context.window.NexoraSession("test", () => expired++),
    values,
    expired: () => expired,
  };
}
const response = (status, data) => ({
  status,
  ok: status < 400,
  json: async () => data,
});
test("customer and driver simultaneous failures refresh once and retain request idempotency headers", async () => {
  let refreshes = 0;
  const keys = [];
  const { session } = setup(async (path, options) => {
    if (path.endsWith("/auth/refresh")) {
      refreshes++;
      await new Promise((r) => setImmediate(r));
      return response(200, { token: "fresh", refresh_token: "new-refresh" });
    }
    keys.push(options.headers["Idempotency-Key"]);
    return options.headers.Authorization === "Bearer fresh"
      ? response(200, { ok: true })
      : response(401, {});
  });
  await Promise.all([
    session.api("/trips", {
      method: "POST",
      body: {},
      headers: { "Idempotency-Key": "a" },
    }),
    session.api("/trips", {
      method: "POST",
      body: {},
      headers: { "Idempotency-Key": "b" },
    }),
  ]);
  assert.equal(refreshes, 1);
  assert.deepEqual(keys, ["a", "b", "a", "b"]);
});
test("signing out during refresh revokes late credentials and cannot restore the session", async () => {
  let resolveRefresh, started;
  const ready = new Promise((r) => (started = r)),
    revoked = [];
  const { session, values } = setup(async (path, options) => {
    if (path.endsWith("/logout")) {
      revoked.push(options.headers.Authorization);
      return response(200, {});
    }
    if (path.endsWith("/refresh")) {
      started();
      return new Promise((r) => (resolveRefresh = r));
    }
    return response(401, {});
  });
  const request = assert.rejects(session.api("/trips"), { status: 401 });
  await ready;
  session.logout();
  resolveRefresh(
    response(200, { token: "late", refresh_token: "late-refresh" }),
  );
  await request;
  assert.equal(values.size, 0);
  assert.deepEqual(revoked, ["Bearer old", "Bearer late"]);
});
test("a refresh outage preserves credentials for recovery", async () => {
  const { session, values, expired } = setup(async (path) => {
    if (path.endsWith("/refresh")) throw new Error("offline");
    return response(401, {});
  });
  await assert.rejects(session.api("/trips"), /offline/);
  assert.equal(values.get("test_token"), "old");
  assert.equal(expired(), 0);
});
test("forbidden resources do not sign out a valid customer", async () => {
  const { session, values, expired } = setup(async () =>
    response(403, { error: "Forbidden" }),
  );
  await assert.rejects(session.api("/admin/drivers"), { status: 403 });
  assert.equal(values.get("test_token"), "old");
  assert.equal(expired(), 0);
});
