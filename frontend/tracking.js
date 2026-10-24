(() => {
  "use strict";
  const W = window.NexoraWorkspace,
    { $, esc, icon } = W;
  W.icons();
  if (W.get("token")) {
    $("tracking-signout").hidden = false;
    $("tracking-signout").onclick = W.signOut;
    $("workspace-link").href = "/ops.html";
  }
  const pathMatch = location.pathname.match(/^\/track\/([^/]+)\/?$/);
  let slug = "";
  try {
    slug = (
      pathMatch
        ? decodeURIComponent(pathMatch[1])
        : new URLSearchParams(location.search).get("id") || ""
    ).trim();
  } catch {
    slug = "";
  }
  $("tracking-code").value = slug;
  $("tracking-search").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = $("tracking-code").value.trim();
    if (!code) {
      $("tracking-code").focus();
      return;
    }
    location.assign("/track/" + encodeURIComponent(code));
  });
  let currentDelivery = null,
    map = null,
    driverMarker = null,
    routeMarkers = [],
    routeLine = null,
    pollTimer = null,
    loading = false;
  const num = (value) =>
    value === null ||
    value === undefined ||
    value === "" ||
    !Number.isFinite(Number(value))
      ? null
      : Number(value);
  const temperature = (value) =>
    num(value) === null ? "Not recorded" : num(value).toFixed(1) + " °C";
  function error(message) {
    $("tracking-error-text").textContent = message;
    $("tracking-error").hidden = false;
  }
  function renderMap(d) {
    const points = [
      [num(d.pickup_lat), num(d.pickup_lng)],
      [num(d.dropoff_lat), num(d.dropoff_lng)],
    ];
    if (
      points.some(
        ([lat, lng]) =>
          lat === null ||
          lng === null ||
          Math.abs(lat) > 90 ||
          Math.abs(lng) > 180,
      )
    ) {
      $("map").hidden = true;
      $("map-empty").hidden = false;
      $("map-caption").textContent = "Waiting for valid route coordinates.";
      return;
    }
    if (typeof L === "undefined") {
      $("map-caption").textContent =
        "The map could not load. Your delivery details are still available.";
      return;
    }
    const current = [num(d.current_lat), num(d.current_lng)];
    const hasLocation =
      current.every((v) => v !== null) &&
      Math.abs(current[0]) <= 90 &&
      Math.abs(current[1]) <= 180;
    const fitMap = !map || $("map").hidden || (hasLocation && !driverMarker);
    $("map").hidden = false;
    $("map-empty").hidden = true;
    $("map-caption").textContent = hasLocation
      ? "Latest reported driver location."
      : "Pickup and destination · Waiting for driver location.";
    if (!map) {
      map = L.map("map", { zoomControl: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        referrerPolicy: "strict-origin",
        errorTileUrl: "/assets/map-unavailable.svg",
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      L.control.zoom({ position: "topright" }).addTo(map);
      routeMarkers = points.map((point, index) =>
        L.marker(point, {
          title: index ? "Destination" : "Pickup",
          keyboard: false,
          icon: L.divIcon({
            className: "",
            html: `<div class="delivery-pin ${index ? "destination" : ""}"></div>`,
            iconSize: [14, 14],
          }),
        }).addTo(map),
      );
      routeLine = L.polyline(points, {
        color: "#79906d",
        weight: 3,
        dashArray: "6,8",
      }).addTo(map);
    } else {
      routeMarkers.forEach((marker, index) => marker.setLatLng(points[index]));
      routeLine.setLatLngs(points);
    }
    if (hasLocation) {
      if (!driverMarker)
        driverMarker = L.marker(current, {
          title: "Latest reported driver location",
          keyboard: false,
          icon: L.divIcon({
            className: "",
            html: `<div class="delivery-vehicle">${icon("car")}</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          }),
        }).addTo(map);
      else driverMarker.setLatLng(current);
    } else if (driverMarker) {
      map.removeLayer(driverMarker);
      driverMarker = null;
    }
    map.invalidateSize();
    if (fitMap)
      map.fitBounds(hasLocation ? [...points, current] : points, {
        padding: [35, 35],
        maxZoom: 15,
      });
  }
  function render(d) {
    $("tracking-placeholder").hidden = true;
    $("tracking-result").hidden = false;
    $("delivery-code").textContent = d.delivery_number || slug;
    $("delivery-status").textContent =
      W.human(d.status || "Awaiting update") + (d.is_demo ? " · Demo" : "");
    $("pickup-address").textContent =
      d.pickup_address || "Awaiting pickup details";
    $("destination-address").textContent =
      d.dropoff_address || "Awaiting destination details";
    $("driver-name").textContent = d.driver_first_name || "Awaiting driver";
    $("driver-vehicle").textContent = [
      [d.make, d.model].filter(Boolean).join(" "),
      d.plate_number,
    ]
      .filter(Boolean)
      .join(" · ");
    if (d.delivered_at || d.status === "delivered")
      $("eta-display").textContent = "Delivered";
    else if (["cancelled", "failed"].includes(d.status))
      $("eta-display").textContent = W.human(d.status);
    else if (
      d.estimated_delivery_at &&
      Number.isFinite(Date.parse(d.estimated_delivery_at))
    ) {
      const mins = Math.round(
        (Date.parse(d.estimated_delivery_at) - Date.now()) / 60000,
      );
      $("eta-display").textContent =
        mins > 0 ? mins + " min" : "Awaiting updated estimate";
    } else $("eta-display").textContent = "Awaiting estimate";
    $("temperature-panel").hidden = !d.temperature;
    if (d.temperature) {
      const t = d.temperature;
      const label =
        {
          IN_RANGE: "Within range",
          RECOVERED: "Back in range",
          OUT_OF_RANGE: "Outside range",
          NO_DATA: "Awaiting readings",
        }[t.status] || "Awaiting update";
      $("temperature-status").textContent = label;
      $("temperature-status").className =
        "badge " + (t.status === "OUT_OF_RANGE" ? "amber" : "");
      $("temperature-value").textContent = temperature(t.current_c);
      $("temperature-range").textContent =
        t.min_c == null || t.max_c == null
          ? "Target range not set"
          : "Target: " + temperature(t.min_c) + " to " + temperature(t.max_c);
      $("temperature-excursions").textContent =
        (t.excursion_readings || 0) + " out-of-range readings";
    }
    $("tracking-updated").textContent =
      "Updated " +
      new Date().toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }) +
      " · Refreshes every 10 seconds";
    renderMap(d);
  }
  async function load() {
    if (!slug || loading) return;
    loading = true;
    $("retry-tracking").disabled = true;
    if (!currentDelivery) $("tracking-loading").hidden = false;
    try {
      const response = await fetch(
        "/api/v1/track/" + encodeURIComponent(slug),
        { signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "We couldn’t find that tracking code. Check it with your sender and try again."
            : response.status === 503
              ? "Tracking is temporarily unavailable. Please try again shortly."
              : "We couldn’t load the latest update. Please try again.",
        );
      const data = await response.json();
      if (!data.delivery)
        throw new Error("No delivery details were returned. Please try again.");
      currentDelivery = data.delivery;
      render(currentDelivery);
      $("tracking-error").hidden = true;
      if (
        ["delivered", "cancelled", "failed"].includes(currentDelivery.status)
      ) {
        clearInterval(pollTimer);
        $("tracking-updated").textContent = "Final delivery status";
      }
    } catch (err) {
      error(
        (currentDelivery ? "Showing the last known update. " : "") +
          (err.name === "TimeoutError" || err instanceof TypeError
            ? "The connection is unavailable. Please try again."
            : err.message),
      );
    } finally {
      loading = false;
      $("tracking-loading").hidden = true;
      $("retry-tracking").disabled = false;
    }
  }
  $("retry-tracking").onclick = load;
  $("temperature-report").onclick = async () => {
    const button = $("temperature-report");
    button.disabled = true;
    try {
      const response = await fetch(
        "/api/v1/track/" + encodeURIComponent(slug) + "/temperature-report",
        { signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok)
        throw new Error(
          "The temperature report is unavailable. Please try again.",
        );
      const report = await response.json(),
        t = report.temperature || {};
      W.dialog(
        "Temperature report",
        `<p>${esc(report.report_id || slug)}${report.is_demo ? " · Demo data" : ""}</p><dl class="report-details">${[
          ["Cargo", report.cargo_description || "Not provided"],
          [
            "Target range",
            temperature(t.min_c) + " to " + temperature(t.max_c),
          ],
          ["Latest reading", temperature(t.current_c)],
          ["Out-of-range readings", t.excursion_readings ?? 0],
          ["Result", W.human(report.verdict || "Not available")],
        ]
          .map(
            ([key, value]) =>
              `<div><dt>${key}</dt><dd>${esc(value)}</dd></div>`,
          )
          .join("")}</dl>`,
      );
    } catch (err) {
      error(err.message);
    } finally {
      button.disabled = false;
    }
  };
  if (slug) {
    pollTimer = setInterval(() => {
      if (!document.hidden) load();
    }, 10000);
    load();
  }
})();
