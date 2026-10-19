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
  const navigations = [];
  const listeners = {};
  const context = {
    fetch,
    AbortSignal,
    Event,
    setTimeout,
    clearTimeout,
    URL,
    document: { querySelector: () => null },
    location: { pathname: "/ops", replace: (path) => navigations.push(path) },
    window: {
      dispatchEvent: (event) => events.push(event.type),
      addEventListener: (name, listener) => {
        listeners[name] = listener;
      },
    },
    sessionStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };
  vm.runInNewContext(fs.readFileSync("frontend/workspace.js", "utf8"), context);
  return {
    ...context.window.NexoraWorkspace,
    values,
    events,
    navigations,
    listeners,
  };
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

test("sign-out clears credentials and leaves immediately when revocation stalls", () => {
  const requests = [];
  const { signOut, values, events, navigations } = workspace(
    (path, options) => {
      requests.push({ path, options });
      return new Promise(() => {});
    },
  );
  signOut();
  assert.equal(values.size, 0);
  assert.deepEqual(navigations, ["/admin.html"]);
  assert.deepEqual(events, ["nexora:signed-out"]);
  assert.equal(requests[0].path, "/api/v1/auth/logout");
  assert.equal(requests[0].options.keepalive, true);
  assert.equal(requests[0].options.headers.Authorization, "Bearer old-token");
  assert.equal(
    JSON.parse(requests[0].options.body).refresh_token,
    "refresh-token",
  );
  signOut();
  assert.equal(requests.length, 1);
});

test("sign-out works offline", async () => {
  const { signOut, values, navigations } = workspace(async () => {
    throw new TypeError("Offline");
  });
  signOut();
  assert.equal(values.size, 0);
  assert.deepEqual(navigations, ["/admin.html"]);
});

test("a refresh finishing after sign-out cannot restore credentials", async () => {
  let finishRefresh, refreshStarted;
  const started = new Promise((resolve) => {
    refreshStarted = resolve;
  });
  const revocations = [];
  const { api, signOut, values } = workspace(async (path, options) => {
    if (path.endsWith("/auth/logout")) {
      revocations.push(options.headers.Authorization);
      return response(200, {});
    }
    if (path.endsWith("/auth/refresh")) {
      refreshStarted();
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    }
    return response(401, { error: "expired" });
  });
  const pending = api("/ops/overview");
  await started;
  signOut();
  finishRefresh(
    response(200, { token: "late-token", refresh_token: "late-refresh" }),
  );
  await assert.rejects(pending, { status: 401 });
  assert.equal(values.size, 0);
  assert.deepEqual(revocations, ["Bearer old-token", "Bearer late-token"]);
});

test("a previous session's pending refresh cannot expire a new sign-in", async () => {
  let finishOldRefresh, refreshStarted;
  const started = new Promise((resolve) => {
    refreshStarted = resolve;
  });
  const refreshTokens = [];
  const { api, save, values, events } = workspace(async (path, options) => {
    if (path.endsWith("/auth/logout")) return response(200, {});
    if (path.endsWith("/auth/refresh")) {
      const token = JSON.parse(options.body).refresh_token;
      refreshTokens.push(token);
      if (token === "refresh-token") {
        refreshStarted();
        return new Promise((resolve) => {
          finishOldRefresh = resolve;
        });
      }
      return response(200, {
        token: "current-token",
        refresh_token: "current-refresh",
      });
    }
    return options.headers.Authorization === "Bearer current-token"
      ? response(200, { ok: true })
      : response(401, { error: "expired" });
  });
  const oldRequest = assert.rejects(api("/ops/overview"), { status: 401 });
  await started;
  save({
    token: "login-token",
    refresh_token: "login-refresh",
    user: { first_name: "New" },
  });
  const newRequest = api("/admin/drivers");
  finishOldRefresh(
    response(200, { token: "stale-token", refresh_token: "stale-refresh" }),
  );
  await oldRequest;
  assert.deepEqual(await newRequest, { ok: true });
  assert.deepEqual(refreshTokens, ["refresh-token", "login-refresh"]);
  assert.equal(values.get("nexora_ops_token"), "current-token");
  assert.deepEqual(events, []);
});

test("a login finishing after sign-out revokes the unused credentials", async () => {
  let finishLogin;
  const revocations = [];
  const { api, signOut, values } = workspace(async (path, options) => {
    if (path.endsWith("/auth/logout")) {
      revocations.push(options.headers.Authorization);
      return response(200, {});
    }
    return new Promise((resolve) => {
      finishLogin = resolve;
    });
  });
  const pending = api("/auth/login", {
    email: "ops@example.test",
    password: "test",
  });
  signOut();
  finishLogin(
    response(200, { token: "unused-token", refresh_token: "unused-refresh" }),
  );
  await assert.rejects(pending, { status: 401 });
  assert.equal(values.size, 0);
  assert.deepEqual(revocations, ["Bearer old-token", "Bearer unused-token"]);
});

test("back-forward cache cannot reopen a signed-out workspace", () => {
  const { signOut, listeners, navigations, events } = workspace(async () =>
    response(200, {}),
  );
  signOut();
  listeners.pageshow({ persisted: true });
  assert.deepEqual(navigations, ["/admin.html", "/admin.html"]);
  assert.equal(events.at(-1), "nexora:signed-out");
});
