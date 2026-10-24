const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const read = (name) => fs.readFileSync("frontend/" + name, "utf8");
async function fixture(
  page,
  { signedIn = true, available = true, handler } = {},
) {
  const dom = new JSDOM(read(page + ".html"), {
    url: "https://nexora.test/" + page + ".html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window,
    store = new Map(
      signedIn
        ? [
            ["token", "test-token"],
            ["name", "Alex"],
          ]
        : [],
    ),
    calls = [];
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function (value = "") {
    this.returnValue = value;
    this.removeAttribute("open");
    this.dispatchEvent(new w.Event("close"));
  };
  w.AbortSignal.timeout = () => new w.AbortController().signal;
  w.fetch = async () => ({
    ok: true,
    json: async () => ({ service_areas: [] }),
  });
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (handler) {
      const answer = await handler(path, options);
      if (answer !== undefined) return answer;
    }
    if (path === "/config")
      return { booking_available: available, card_payments: false };
    if (path === "/trips") return { trips: [] };
    if (path === "/deliveries" && !options.body) return { deliveries: [] };
    if (path.startsWith("/places/search"))
      return {
        places: [
          {
            address: decodeURIComponent(path.split("q=")[1]) + ", Test City",
            lat: 40.75,
            lng: -73.98,
          },
        ],
      };
    if (path === "/auth/login")
      return {
        token: "test-token",
        user: { role: "customer", first_name: "Alex" },
      };
    throw new Error("Unexpected API request " + path);
  };
  w.NexoraSession = () => ({
    get: (k) => store.get(k),
    set: (k, v) => (v == null ? store.delete(k) : store.set(k, v)),
    api,
    save: () => store.set("token", "test-token"),
    logout: () => store.clear(),
  });
  w.NexoraNotifications = { disable: async () => {}, enable: async () => {} };
  w.eval(read("ui.js"));
  w.eval(read(page + ".js"));
  await tick();
  const $ = (id) => w.document.getElementById(id);
  const input = (id, value) => {
    const e = $(id) || w.document.querySelector(`[name="${id}"]`);
    e.value = value;
    e.dispatchEvent(new w.Event("input", { bubbles: true }));
    return e;
  };
  const click = async (id) => {
    $(id).click();
    await tick();
  };
  const submit = async (id) => {
    $(id).dispatchEvent(
      new w.Event("submit", { cancelable: true, bubbles: true }),
    );
    await tick();
  };
  const select = async (kind, value) => {
    input(kind + "-address", value);
    await click("search-" + kind);
    $(kind + "-results")
      .querySelector("button")
      .click();
    await tick();
  };
  return {
    w,
    dom,
    $,
    input,
    click,
    submit,
    select,
    calls,
    store,
    close: () => w.close(),
  };
}
test("route drafts expire, stay service-specific, and are consumed once", async () => {
  const f = await fixture("customer", { signedIn: false });
  try {
    const d = f.w.NexoraUI.drafts;
    assert.equal(
      d.save({ service: "delivery", pickup: "A", dropoff: "B" }),
      true,
    );
    assert.equal(d.take("ride"), null);
    assert.equal(d.take("delivery").pickup, "A");
    assert.equal(d.take("delivery"), null);
    f.w.sessionStorage.setItem(
      "nexora_journey_draft",
      JSON.stringify({
        service: "ride",
        pickup: "Private",
        expires: Date.now() - 1,
      }),
    );
    assert.equal(d.take("ride"), null);
  } finally {
    f.close();
  }
});
test("guest route is preserved through contextual sign-in, then search resumes", async () => {
  const f = await fixture("customer", { signedIn: false });
  try {
    f.input("pickup-address", "Station");
    f.input("dropoff-address", "Park");
    await f.click("search-pickup");
    assert.equal(f.$("auth").open, true);
    assert.equal(
      f.calls.some((c) => c.path.startsWith("/places/")),
      false,
    );
    await f.submit("login");
    assert.equal(f.$("auth").open, false);
    assert.equal(f.$("dropoff-address").value, "Park");
    assert.match(f.$("pickup-results").textContent, /Station/);
  } finally {
    f.close();
  }
});
const quote = () => ({
  quote_token: "fixture-quote",
  expires_at: new Date(Date.now() + 300000).toISOString(),
  price_estimate: {
    total_fare: 12.5,
    currency: "USD",
    route: { distance_km: 5, duration_minutes: 12, source: "mapbox" },
  },
});
test("ride review, mobile fare action, editing and expiry cannot submit a stale quote", async () => {
  const f = await fixture("customer", {
    handler: (path) => (path === "/trips/estimate" ? quote() : undefined),
  });
  try {
    await f.select("pickup", "Station");
    await f.select("dropoff", "Park");
    await f.submit("ride");
    assert.equal(f.$("ride").hidden, true);
    assert.equal(f.$("quote").hidden, false);
    assert.match(f.$("dock-value").textContent, /12.50/);
    await f.click("edit-journey");
    assert.equal(f.$("quote").hidden, true);
    assert.equal(f.$("ride").hidden, false);
    await f.click("confirm-booking");
    assert.equal(
      f.calls.some((c) => c.path === "/trips" && c.body),
      false,
    );
    assert.match(f.$("ride-error").textContent, /expired/);
  } finally {
    f.close();
  }
});
test("unavailable bookings fail closed and disable the ride mobile action", async () => {
  const f = await fixture("customer", { signedIn: false, available: false });
  try {
    assert.equal(f.$("estimate").disabled, true);
    assert.equal(f.$("dock-action").disabled, true);
  } finally {
    f.close();
  }
});
async function deliveryDetails(f) {
  await f.select("pickup", "Station");
  await f.select("dropoff", "Park");
  await f.click("to-details");
  for (const [key, value] of Object.entries({
    cargo_description: "Books",
    pickup_contact_name: "Alex",
    pickup_contact_phone: "+15550000001",
    dropoff_contact_name: "Robin",
    dropoff_contact_phone: "+15550000002",
  }))
    f.input(key, value);
}
test("delivery requires selected addresses and valid contact details before a quote", async () => {
  const f = await fixture("freight", {
    handler: (path) => (path === "/deliveries/estimate" ? quote() : undefined),
  });
  try {
    await f.click("to-details");
    assert.match(f.$("delivery-error").textContent, /select both/);
    await f.select("pickup", "Station");
    await f.select("dropoff", "Park");
    await f.click("to-details");
    await f.submit("delivery");
    assert.equal(
      f.calls.some((c) => c.path === "/deliveries/estimate"),
      false,
    );
    await deliveryDetails(f);
    await f.submit("delivery");
    assert.equal(f.$("quote").hidden, false);
    assert.match(f.$("review-details").textContent, /Robin/);
    assert.match(f.$("dock-value").textContent, /12.50/);
    f.w.document.querySelector('[data-back="2"]').click();
    assert.equal(f.$("quote").hidden, true);
    assert.equal(f.w.document.querySelector('[data-panel="2"]').hidden, false);
  } finally {
    f.close();
  }
});
test("delivery retry reuses its idempotency key after a lost response", async () => {
  let attempts = 0;
  const f = await fixture("freight", {
    handler: (path, options) => {
      if (path === "/deliveries/estimate") return quote();
      if (path === "/deliveries" && options.body) {
        if (++attempts === 1) throw new Error("Connection interrupted");
        return { delivery: { id: "one", delivery_number: "DEL-ONE" } };
      }
    },
  });
  try {
    await deliveryDetails(f);
    await f.submit("delivery");
    await f.click("confirm");
    await f.click("confirm");
    const creates = f.calls.filter((c) => c.path === "/deliveries" && c.body);
    assert.equal(creates.length, 2);
    assert.equal(
      creates[0].headers["Idempotency-Key"],
      creates[1].headers["Idempotency-Key"],
    );
    assert.match(f.$("booking-message").textContent, /DEL-ONE/);
    assert.equal(f.$("delivery-dock").hidden, true);
    assert.equal(f.$("new-delivery").hidden, false);
    await f.click("new-delivery");
    assert.equal(f.$("pickup-address").value, "");
    assert.equal(f.$("delivery-dock").hidden, false);
    f.$("booking-message").textContent = "Private delivery";
    await f.click("logout");
    assert.equal(f.$("booking-message").textContent, "");
  } finally {
    f.close();
  }
});
test("delivery rejects an expired quote and returns to editable details", async () => {
  const f = await fixture("freight", {
    handler: (path) =>
      path === "/deliveries/estimate"
        ? { ...quote(), expires_at: new Date(Date.now() - 1000).toISOString() }
        : undefined,
  });
  try {
    await deliveryDetails(f);
    await f.submit("delivery");
    await f.click("confirm");
    assert.match(f.$("delivery-error").textContent, /expired/);
    assert.equal(
      f.calls.some((c) => c.path === "/deliveries" && c.body),
      false,
    );
    assert.equal(f.w.document.querySelector('[data-panel="2"]').hidden, false);
  } finally {
    f.close();
  }
});
test("shared PIN dialog validates input and cancels without accepting an action", async () => {
  const f = await fixture("customer", { signedIn: false });
  try {
    let result = f.w.NexoraUI.ask({
      title: "Pickup",
      message: "Enter PIN",
      input: true,
    });
    let dialog = f.w.document.querySelector("dialog[open]");
    let pin = dialog.querySelector("input");
    pin.value = "123";
    assert.equal(pin.checkValidity(), false);
    pin.value = "123456";
    assert.equal(pin.checkValidity(), true);
    dialog.close("confirm");
    assert.equal(await result, "123456");
    result = f.w.NexoraUI.ask({
      title: "Cancel?",
      message: "Confirm cancellation",
    });
    f.w.document.querySelector("dialog[open]").close("cancel");
    assert.equal(await result, null);
  } finally {
    f.close();
  }
});

test("ride handoffs accept the actual four-digit rider PIN", async () => {
  const f = await fixture("customer", { signedIn: false });
  try {
    const result = f.w.NexoraUI.ask({
      title: "Start ride",
      message: "Rider PIN",
      input: true,
      digits: 4,
    });
    const dialog = f.w.document.querySelector("dialog[open]"),
      pin = dialog.querySelector("input");
    pin.value = "1234";
    assert.equal(pin.checkValidity(), true);
    assert.match(dialog.textContent, /4-digit/);
    dialog.close("confirm");
    assert.equal(await result, "1234");
  } finally {
    f.close();
  }
});

test("consumer navigation and assets resolve to real local files", () => {
  const pages = [
    "index",
    "customer",
    "freight",
    "driver",
    "driver-register",
    "account-recovery",
    "help",
    "privacy",
    "terms",
  ];
  for (const page of pages) {
    const dom = new JSDOM(read(page + ".html"), {
        url: "https://nexora.test/" + page + ".html",
      }),
      doc = dom.window.document;
    const ids = [...doc.querySelectorAll("[id]")].map((el) => el.id);
    assert.equal(new Set(ids).size, ids.length, `${page} has duplicate IDs`);
    for (const element of doc.querySelectorAll(
      'a[href],script[src],link[rel="stylesheet"],img[src],use[href]',
    )) {
      const raw = element.getAttribute("href") || element.getAttribute("src");
      const url = new URL(raw, "https://nexora.test/" + page + ".html");
      if (url.origin !== "https://nexora.test") continue;
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      assert.equal(
        fs.existsSync("frontend" + path),
        true,
        `${page} links to missing ${path}`,
      );
    }
    dom.window.close();
  }
});
