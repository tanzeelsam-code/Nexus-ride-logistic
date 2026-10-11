/* Shared, light operations workspace. All requests keep the existing API and session contract. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const paths = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    users:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    car: "m5 7 2-4h10l2 4 M3 7h18v10H3z M5 17v3 M19 17v3 M6 12h2 M16 12h2",
    box: "m12 3 9 5v9l-9 5-9-5V8l9-5 M3 8l9 5 9-5 M12 13v9 M7.5 5.5l9 5",
    bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4",
    pin: "M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0 M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    arrow: "M5 12h14 M13 6l6 6-6 6",
    external: "M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7",
    logout: "M9 3H3v18h6 M10 12h11 M16 7l5 5-5 5",
    menu: "M4 6h16 M4 12h16 M4 18h16",
    close: "m6 6 12 12 M6 18 18 6",
    refresh: "M20 7a9 9 0 1 0 1 9 M20 2v6h-6",
    download: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
    plus: "M12 5v14 M5 12h14",
    clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2",
    check: "m5 12 4 4L19 6",
    shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3 M8 12l3 3 5-6",
    search: "M19 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 15l6 6",
    wallet: "M3 6V4h16v4 M3 8h18v13H3V8 M21 12h-6v5h6",
    leaf: "M20 3C7 2 2 8 6 15c7 5 14 0 14-12 M4 21 15 10",
    temp: "M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0 M12 8v10 M18 6h3 M18 10h3",
    link: "m10 13 4-4 M9 15l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M15 9l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  };
  const icon = (name) =>
    `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="${paths[name] || paths.grid}"/></svg>`;
  function icons(root = document) {
    root.querySelectorAll("[data-icon]").forEach((el) => {
      el.innerHTML = icon(el.dataset.icon);
    });
  }
  const get = (key) => sessionStorage.getItem("nexora_ops_" + key);
  const set = (key, value) =>
    value == null
      ? sessionStorage.removeItem("nexora_ops_" + key)
      : sessionStorage.setItem("nexora_ops_" + key, value);
  const clear = () =>
    ["token", "refresh", "name"].forEach((key) => set(key, null));
  function save(data) {
    set("token", data.token);
    set("refresh", data.refresh_token);
    set(
      "name",
      [data.user.first_name, data.user.last_name].filter(Boolean).join(" "),
    );
  }
  let refreshPromise, toastTimer;
  async function api(path, body, retry = true) {
    const token = get("token");
    const response = await fetch("/api/v1" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await response
      .json()
      .catch(() => ({ error: "The service returned an unexpected response." }));
    if (response.status === 401 && !path.startsWith("/auth/")) {
      if (retry && get("refresh")) {
        try {
          if (!refreshPromise)
            refreshPromise = api(
              "/auth/refresh",
              { refresh_token: get("refresh") },
              false,
            )
              .then((fresh) => {
                set("token", fresh.token);
                set("refresh", fresh.refresh_token);
              })
              .finally(() => {
                refreshPromise = null;
              });
          await refreshPromise;
        } catch (error) {
          // A transient network failure should not erase a valid saved session.
          if (error.status !== 401 && error.status !== 403) throw error;
          clear();
          window.dispatchEvent(new Event("nexora:session-expired"));
          const expired = new Error(
            "Your session expired. Please sign in again.",
          );
          expired.status = 401;
          throw expired;
        }
        return api(path, body, false);
      }
      clear();
      window.dispatchEvent(new Event("nexora:session-expired"));
      const error = new Error("Your session expired. Please sign in again.");
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const details = Object.values(data.details?.fieldErrors || {})
        .flat()
        .join(" ");
      const error = new Error(
        details ||
          data.error ||
          "Unable to complete the request. Please try again.",
      );
      error.status = response.status;
      throw error;
    }
    return data;
  }
  async function signOut() {
    const request = api("/auth/logout", {
      refresh_token: get("refresh"),
    }).catch(() => {});
    clear();
    // Let the revocation request finish before leaving the page.
    await request;
    location.href = "admin.html";
  }
  const initials = (name) =>
    String(name || "Account")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((n) => n[0])
      .join("")
      .toUpperCase();
  function shell(active) {
    const nav = (href, name, glyph, id, external = false) =>
      `<a class="nav-link" href="${href}" ${active === id ? 'aria-current="page"' : ""} data-nav="${id}">${icon(glyph)}${name}${external ? icon("external").replace('class="icon"', 'class="icon arrow"') : ""}</a>`;
    $("sidebar").innerHTML =
      `<a class="brand" href="/" aria-label="Nexora home"><span class="brand-mark">n</span><span>nexora<small>Workspace</small></span></a><nav aria-label="Workspace navigation"><div class="nav-group"><p class="eyebrow">Workspace</p>${nav("ops.html", "Overview", "grid", "overview")}${nav("admin.html", "Driver approvals", "users", "admin")}${nav("ops.html#fleet", "Fleet", "car", "fleet")}${nav("ops.html#alerts", "Alerts", "bell", "alerts")}</div><div class="nav-group"><p class="eyebrow">Portals</p>${nav("ride.html", "Ride dispatch", "car", "ride", true)}${nav("freight.html", "Freight logistics", "box", "freight", true)}${nav("track.html", "Live tracking", "pin", "track", true)}</div></nav><div class="sidebar-bottom"><div class="sidebar-note"><strong>A little more connected.</strong>One place for your people, rides, and deliveries.</div><div class="user-menu"><span class="avatar">${esc(initials(get("name")))}</span><div class="user-copy"><strong>${esc(get("name") || "Operations account")}</strong><small>Operations workspace</small></div><button class="subtle" id="signout" aria-label="Sign out" title="Sign out">${icon("logout")}</button></div></div>`;
    $("signout").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      await signOut();
    });
    document.querySelectorAll("[data-menu]").forEach(
      (button) =>
        (button.onclick = () => {
          const open = document.body.classList.toggle("nav-open");
          document
            .querySelector('[data-menu="toggle"]')
            ?.setAttribute("aria-expanded", String(open));
        }),
    );
    document.onkeydown = (event) => {
      if (
        event.key === "Escape" &&
        document.body.classList.contains("nav-open")
      ) {
        document.body.classList.remove("nav-open");
        const toggle = document.querySelector('[data-menu="toggle"]');
        toggle?.setAttribute("aria-expanded", "false");
        toggle?.focus();
      }
    };
    $("sidebar").addEventListener("click", (event) => {
      if (event.target.closest("a")) {
        document.body.classList.remove("nav-open");
        document
          .querySelector('[data-menu="toggle"]')
          ?.setAttribute("aria-expanded", "false");
      }
    });
    if ($("today")) {
      $("today").dateTime = new Date().toISOString().slice(0, 10);
      $("today").textContent = new Date().toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
    icons();
  }
  function toast(message) {
    if (!$("toast")) {
      const el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      el.setAttribute("role", "status");
      document.body.append(el);
    }
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    toastTimer = setTimeout(() => ($("toast").textContent = ""), 5500);
  }
  function empty(glyph, title, description, action = "") {
    return `<div class="empty"><div class="empty-visual">${icon(glyph)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;
  }
  function dialog(title, html) {
    const previous = $("workspace-dialog");
    previous?.close();
    previous?.remove();
    const el = document.createElement("dialog");
    el.id = "workspace-dialog";
    document.body.append(el);
    el.addEventListener("click", (e) => {
      if (e.target === el) {
        const r = el.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          el.close();
      }
    });
    el.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${esc(title)}</h2><button class="icon-button subtle" data-close aria-label="Close dialog">${icon("close")}</button></div><div class="dialog-body">${html}</div>`;
    el.setAttribute("aria-labelledby", "dialog-title");
    el.querySelector("[data-close]").onclick = () => el.close();
    if (!el.open) el.showModal();
    return el;
  }
  const number = (value) =>
    value == null ? "—" : Number(value).toLocaleString();
  const money = (value) =>
    value == null
      ? "—"
      : Number(value).toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        });
  const human = (value) => String(value || "").replaceAll("_", " ");
  window.NexoraWorkspace = {
    $,
    esc,
    icon,
    icons,
    get,
    save,
    api,
    shell,
    toast,
    empty,
    dialog,
    initials,
    number,
    money,
    human,
  };
})();
