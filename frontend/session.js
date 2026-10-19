/* Shared customer/driver authentication with refresh coalescing and sign-out guards. */
(() => {
  "use strict";
  window.NexoraSession = function (prefix, onExpired = () => {}) {
    const get = (key) => sessionStorage.getItem(prefix + "_" + key);
    const set = (key, value) =>
      value == null
        ? sessionStorage.removeItem(prefix + "_" + key)
        : sessionStorage.setItem(prefix + "_" + key, value);
    let generation = 0,
      refreshPromise;
    function clear() {
      generation++;
      refreshPromise = null;
      ["token", "refresh", "name", "trip", "pending_booking"].forEach((k) =>
        set(k, null),
      );
    }
    function revoke(token, refresh) {
      if (!token) return;
      fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ refresh_token: refresh }),
        keepalive: true,
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    function save(data) {
      generation++;
      refreshPromise = null;
      set("token", data.token);
      set("refresh", data.refresh_token);
      set(
        "name",
        [data.user.first_name, data.user.last_name].filter(Boolean).join(" "),
      );
    }
    async function api(path, options = {}, retry = true) {
      const version = generation;
      const res = await fetch("/api/v1" + path, {
        ...options,
        body:
          options.body === undefined
            ? undefined
            : typeof options.body === "string"
              ? options.body
              : JSON.stringify(options.body),
        headers: {
          "Content-Type": "application/json",
          ...(get("token") ? { Authorization: "Bearer " + get("token") } : {}),
          ...options.headers,
        },
        signal: options.signal || AbortSignal.timeout(20000),
      });
      const data = await res
        .json()
        .catch(() => ({
          error: "The service returned an unexpected response.",
        }));
      if (version !== generation) {
        if (path.startsWith("/auth/") && data.token)
          revoke(data.token, data.refresh_token);
        throw Object.assign(new Error("This session has ended."), {
          status: 401,
        });
      }
      if (res.status === 401 && !path.startsWith("/auth/")) {
        if (retry && get("refresh")) {
          try {
            if (!refreshPromise) {
              const promise = api(
                "/auth/refresh",
                { method: "POST", body: { refresh_token: get("refresh") } },
                false,
              )
                .then((fresh) => {
                  if (version !== generation) {
                    revoke(fresh.token, fresh.refresh_token);
                    throw Object.assign(new Error("Session ended"), {
                      status: 401,
                    });
                  }
                  set("token", fresh.token);
                  set("refresh", fresh.refresh_token);
                })
                .finally(() => {
                  if (refreshPromise === promise) refreshPromise = null;
                });
              refreshPromise = promise;
            }
            await refreshPromise;
          } catch (err) {
            if (version === generation && [401, 403].includes(err.status)) {
              clear();
              onExpired();
            }
            throw err;
          }
          if (version !== generation)
            throw Object.assign(new Error("Session ended"), { status: 401 });
          return api(path, options, false);
        }
        clear();
        onExpired();
      }
      if (!res.ok)
        throw Object.assign(
          new Error(
            Object.values(data.details?.fieldErrors || {})
              .flat()
              .join(" ") ||
              data.error ||
              "Request failed",
          ),
          { status: res.status },
        );
      return data;
    }
    function logout() {
      const token = get("token"),
        refresh = get("refresh");
      clear();
      revoke(token, refresh);
    }
    return { api, get, set, save, clear, logout };
  };
})();
