const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function tracking(fetch, pathname = "/track/test-code") {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        hidden: ["map", "tracking-result", "tracking-error"].includes(id),
        textContent: "",
        addEventListener() {},
      });
    return elements.get(id);
  };
  const timers = new Set();
  const markers = new Set();
  const bounds = [];
  const map = {
    fitBounds(points) {
      bounds.push(points);
    },
    invalidateSize() {},
    removeLayer(marker) {
      markers.delete(marker);
    },
  };
  const layer = () => ({
    addTo() {
      return this;
    },
  });
  const context = {
    fetch,
    AbortSignal,
    URLSearchParams,
    location: { pathname, search: "" },
    document: { hidden: false },
    setInterval: (callback) => {
      timers.add(callback);
      return callback;
    },
    clearInterval: (callback) => timers.delete(callback),
    window: {
      NexoraWorkspace: {
        $: element,
        esc: String,
        icon: () => "",
        icons() {},
        get: () => null,
        human: (value) => value.replaceAll("_", " "),
      },
    },
    L: {
      map: () => map,
      tileLayer: layer,
      control: { zoom: layer },
      divIcon: (options) => options,
      marker: (point) => ({
        point,
        addTo() {
          markers.add(this);
          return this;
        },
        setLatLng(next) {
          this.point = next;
        },
      }),
      polyline: (points) => ({
        ...layer(),
        getBounds: () => points,
        setLatLngs() {},
      }),
    },
  };
  vm.runInNewContext(fs.readFileSync("frontend/tracking.js", "utf8"), context);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    element,
    markers,
    bounds,
    timers,
    flush,
    async poll() {
      for (const callback of timers) callback();
      await flush();
    },
  };
}
const delivery = {
  delivery_number: "DEL-TEST",
  status: "in_transit",
  pickup_lat: 40.7,
  pickup_lng: -74,
  dropoff_lat: 40.8,
  dropoff_lng: -73.9,
  current_lat: 41.2,
  current_lng: -73.5,
};
const response = (data, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => ({ delivery: data }),
});

test("an empty tracking page does not request or poll a delivery", async () => {
  let calls = 0;
  const page = tracking(async () => {
    calls++;
  }, "/track.html");
  await page.flush();
  assert.equal(calls, 0);
  assert.equal(page.timers.size, 0);
  assert.equal(page.element("tracking-result").hidden, true);
});

test("the initial map includes the reported driver outside the pickup and dropoff bounds", async () => {
  const page = tracking(async () => response(delivery));
  await page.flush();
  assert.equal(page.element("tracking-error").hidden, true);
  assert.equal(page.markers.size, 3);
  assert.ok(
    page.bounds.at(-1).some(([lat, lng]) => lat === 41.2 && lng === -73.5),
  );
});

test("missing driver coordinates remove the old vehicle location", async () => {
  let data = delivery;
  const page = tracking(async () => response(data));
  await page.flush();
  data = { ...delivery, current_lat: null, current_lng: null };
  await page.poll();
  assert.equal(page.markers.size, 2);
  assert.match(
    page.element("map-caption").textContent,
    /Waiting for driver location/,
  );
});

test("invalid route coordinates hide the old map and valid data restores it", async () => {
  let data = delivery;
  const page = tracking(async () => response(data));
  await page.flush();
  data = { ...delivery, pickup_lat: null };
  await page.poll();
  assert.equal(page.element("map").hidden, true);
  assert.equal(page.element("map-empty").hidden, false);
  data = delivery;
  await page.poll();
  assert.equal(page.element("map").hidden, false);
  assert.equal(page.element("map-empty").hidden, true);
});

test("a failed poll preserves the delivery and identifies it as the last known update", async () => {
  let status = 200;
  const page = tracking(async () => response(delivery, status));
  await page.flush();
  status = 503;
  await page.poll();
  assert.equal(page.element("delivery-code").textContent, "DEL-TEST");
  assert.equal(page.element("tracking-result").hidden, false);
  assert.equal(page.element("tracking-error").hidden, false);
  assert.match(
    page.element("tracking-error-text").textContent,
    /Showing the last known update/,
  );
});

test("a final delivery stops polling", async () => {
  const page = tracking(async () =>
    response({ ...delivery, status: "delivered" }),
  );
  await page.flush();
  assert.equal(page.timers.size, 0);
  assert.equal(page.element("eta-display").textContent, "Delivered");
  assert.equal(
    page.element("tracking-updated").textContent,
    "Final delivery status",
  );
});
