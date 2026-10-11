const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function workspace(fetch) {
  const values = new Map([
    ["nexora_ops_token", "old-token"],
    ["nexora_ops_refresh", "refresh-token"],
  ]);
  const events = [];
  const context = {
    fetch,
    AbortSignal,
    Event,
    setTimeout,
    clearTimeout,
    URL,
    document: {},
    window: { dispatchEvent: (event) => events.push(event.type) },
    sessionStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };
  vm.runInNewContext(fs.readFileSync("frontend/workspace.js", "utf8"), context);
  return { api: context.window.NexoraWorkspace.api, values, events };
}
const response = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

test("simultaneous expired requests share one refresh and retry with the new token", async () => {
  let refreshes = 0;
  const { api, values, events } = workspace(async (path, options) => {
    if (path.endsWith("/auth/refresh")) {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(200, {
        token: "new-token",
        refresh_token: "new-refresh",
      });
    }
    return options.headers.Authorization === "Bearer new-token"
      ? response(200, { ok: true })
      : response(401, { error: "expired" });
  });
  const results = await Promise.all([
    api("/ops/overview"),
    api("/admin/drivers"),
  ]);
  assert.equal(
    results.every((result) => result.ok),
    true,
  );
  assert.equal(refreshes, 1);
  assert.equal(values.get("nexora_ops_refresh"), "new-refresh");
  assert.equal(events.length, 0);
});

test("a forbidden resource after refresh keeps the valid session", async () => {
  let refreshed = false;
  const { api, values, events } = workspace(async (path) => {
    if (path.endsWith("/auth/refresh")) {
      refreshed = true;
      return response(200, {
        token: "new-token",
        refresh_token: "new-refresh",
      });
    }
    return response(refreshed ? 403 : 401, {
      error: refreshed ? "Not permitted" : "expired",
    });
  });
  await assert.rejects(api("/admin/drivers"), {
    message: "Not permitted",
    status: 403,
  });
  assert.equal(values.get("nexora_ops_token"), "new-token");
  assert.equal(events.length, 0);
});

test("a network outage during refresh preserves the session for retry", async () => {
  const { api, values, events } = workspace(async (path) => {
    if (path.endsWith("/auth/refresh"))
      throw new TypeError("Network unavailable");
    return response(401, { error: "expired" });
  });
  await assert.rejects(api("/ops/overview"), {
    message: "Network unavailable",
  });
  assert.equal(values.get("nexora_ops_token"), "old-token");
  assert.equal(events.length, 0);
});

test("an invalid refresh clears credentials and requests sign-in", async () => {
  const { api, values, events } = workspace(async () =>
    response(401, { error: "invalid token" }),
  );
  await assert.rejects(api("/ops/overview"), { status: 401 });
  assert.equal(values.size, 0);
  assert.deepEqual(events, ["nexora:session-expired"]);
});

test("a login failure does not attempt to refresh an unrelated session", async () => {
  let calls = 0;
  const { api, events } = workspace(async () => {
    calls++;
    return response(401, { error: "Invalid credentials" });
  });
  await assert.rejects(
    api("/auth/login", {
      email: "test@example.test",
      password: "not-a-password",
    }),
    { message: "Invalid credentials" },
  );
  assert.equal(calls, 1);
  assert.equal(events.length, 0);
});
