(() => {
  "use strict";
  const W = window.NexoraWorkspace,
    { $, esc, icon, api, empty, number, money, human } = W;
  if (!W.get("token")) {
    location.replace("admin.html?next=ops");
    return;
  }
  window.addEventListener("nexora:session-expired", () =>
    location.replace("admin.html?next=ops"),
  );
  let data = null,
    loading = false,
    activity = "trips",
    fleetFilter = "all";
  W.shell("overview");
  function view() {
    const current = ["fleet", "alerts"].includes(location.hash.slice(1))
      ? location.hash.slice(1)
      : "overview";
    ["overview", "fleet", "alerts"].forEach(
      (id) => ($(id + "-view").hidden = id !== current),
    );
    document.querySelectorAll("[data-nav]").forEach((a) => {
      if (a.dataset.nav === current) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    const copy = {
      overview: [
        "Operations overview",
        "A clear view of everything moving with Nexora.",
      ],
      fleet: [
        "Your fleet",
        "The people and vehicles that keep your network moving.",
      ],
      alerts: [
        "Alerts & updates",
        "Stay close to the things that need your attention.",
      ],
    }[current];
    $("page-title").textContent = copy[0];
    $("page-description").textContent = copy[1];
    $("breadcrumb-view").textContent =
      current[0].toUpperCase() + current.slice(1);
    document.title = copy[0] + " · Nexora";
  }
  window.addEventListener("hashchange", view);
  view();
  const online = (d) =>
    d.is_online === true ||
    (data?.demo && d.is_online == null && d.status !== "offline");
  function driverTable(drivers, compact = false) {
    if (!drivers.length)
      return empty(
        "car",
        compact ? "A little quiet on the roads." : "No drivers to show",
        compact
          ? "When approved drivers go online, you’ll see them here."
          : "Try a different filter or review new driver registrations.",
        '<a class="button" href="admin.html">Review drivers ' +
          icon("arrow") +
          "</a>",
      );
    return `<div class="table-scroll"><table class="${compact ? "compact-table" : ""}"><thead><tr><th scope="col">Driver</th><th scope="col">Service</th><th scope="col">Status</th>${compact ? "" : '<th scope="col">Location</th>'}</tr></thead><tbody>${drivers.map((d) => `<tr><td><div class="person"><span class="avatar">${esc(W.initials(d.name))}</span><div><strong>${esc(d.name || "Driver")}</strong><small>${esc(human(d.vehicle_type) || "Vehicle not listed")}</small></div></div></td><td>${esc(d.mode === "both" ? "Rides & freight" : d.mode === "ride" ? "Rides" : human(d.mode))}</td><td><span class="badge ${online(d) ? "" : "neutral"}"><span class="dot"></span>${online(d) ? "Online" : "Offline"}</span></td>${compact ? "" : `<td>${d.lat != null && d.lng != null && Number.isFinite(Number(d.lat)) && Number.isFinite(Number(d.lng)) ? `<a href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(d.lat)}&mlon=${encodeURIComponent(d.lng)}#map=15/${encodeURIComponent(d.lat)}/${encodeURIComponent(d.lng)}" target="_blank" rel="noopener noreferrer">View location ↗</a>` : '<span class="muted">Not available</span>'}</td>`}</tr>`).join("")}</tbody></table></div>`;
  }
  function renderFleet() {
    if (!data) return;
    const query = $("fleet-search").value.trim().toLowerCase();
    const drivers = (data.fleet?.drivers || []).filter(
      (d) =>
        (fleetFilter === "all" ||
          (fleetFilter === "online" ? online(d) : !online(d))) &&
        [d.name, d.vehicle_type].join(" ").toLowerCase().includes(query),
    );
    $("fleet-table").innerHTML = driverTable(drivers);
  }
  function alertList(alerts) {
    return alerts.length
      ? `<div class="activity-list">${alerts.map((a) => `<article class="activity-row"><div class="row-top"><strong>${esc(a.title || "Operations update")}</strong><span class="badge ${a.type === "critical" ? "red" : "amber"}">${esc(human(a.type || "Update"))}</span></div><p class="muted">${esc(a.desc || a.reasoning || "")}</p></article>`).join("")}</div>`
      : empty(
          "bell",
          "All clear for now.",
          "Fleet updates and temperature alerts will appear here.",
        );
  }
  function renderActivity() {
    if (!data) return;
    const items = data[activity] || [];
    if (activity === "alerts") {
      $("activity").innerHTML = alertList(items.slice(0, 5));
      return;
    }
    if (!items.length) {
      $("activity").innerHTML = empty(
        activity === "trips" ? "pin" : "box",
        activity === "trips"
          ? "Ready for the next journey."
          : "Ready for the next delivery.",
        activity === "trips"
          ? "Active rides will appear here as customers book and drivers accept."
          : "New deliveries will appear here as they move through your network.",
      );
      return;
    }
    $("activity").innerHTML = `<div class="activity-list">${items
      .slice(0, 6)
      .map(
        (t) =>
          `<article class="activity-row"><div class="row-top"><strong>${esc(t.ref || t.id)}</strong><span class="badge">${esc(human(t.status))}</span></div><p class="route-line">${icon("pin")}${esc(t.from || "Pickup")} → ${esc(t.to || "Destination")}</p><p><small>${esc(t.driver || "Awaiting driver")} · ${esc(money(t.fare))}</small></p></article>`,
      )
      .join(
        "",
      )}</div>${items.length > 6 ? '<p class="table-note">Showing 6 of ' + items.length + " recent jobs. Export for the full current snapshot.</p>" : ""}`;
  }
  function render() {
    const m = data.metrics || {},
      f = data.fleet || {};
    for (const [id, value] of Object.entries({
      "active-rides": m.active_trips,
      "active-deliveries": m.active_deliveries,
      "online-drivers": f.online_total,
      "ride-drivers": f.ride_only,
      "freight-drivers": f.freight_only,
      "dual-drivers": f.dual_mode,
      completed: m.completed_today,
    }))
      $(id).textContent = number(value);
    $("today-revenue").textContent = money(m.today_revenue);
    $("average-eta").textContent =
      m.avg_eta_minutes == null
        ? "Not yet available"
        : number(m.avg_eta_minutes) + " min";
    $("average-rating").textContent =
      m.avg_rating == null
        ? "Not yet rated"
        : Number(m.avg_rating).toFixed(1) + " / 5";
    $("activity-count").textContent =
      number((m.active_trips || 0) + (m.active_deliveries || 0)) + " active";
    $("fleet-preview").innerHTML = driverTable(
      (f.drivers || []).filter(online).slice(0, 4),
      true,
    );
    renderFleet();
    renderActivity();
    $("alerts-list").innerHTML = alertList(data.alerts || []);
    $("alerts-count").textContent = (data.alerts || []).length + " recent";
    const shipments = data.cold_chain?.shipments || [];
    $("cold-chain").innerHTML = shipments.length
      ? `<div class="activity-list">${shipments
          .slice(0, 3)
          .map(
            (s) =>
              `<div class="activity-row"><div class="row-top"><strong>${esc(s.id)}</strong><span class="badge ${s.current_temp_c == null ? "neutral" : s.status === "NORMAL" ? "" : "amber"}">${s.current_temp_c == null ? "Awaiting reading" : esc(s.current_temp_c) + " °C"}</span></div><small>${esc(s.cargo || "Refrigerated shipment")}</small></div>`,
          )
          .join(
            "",
          )}</div><div class="panel-footer">${number(shipments.length)} monitored · ${number(data.cold_chain.active_excursions)} exceptions</div>`
      : empty(
          "temp",
          "Nothing to monitor yet.",
          "Refrigerated shipments and their latest readings will appear here.",
        );
    $("demo-notice").hidden = !data.demo;
    $("export").disabled = false;
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    $("refresh").disabled = true;
    try {
      data = await api("/ops/overview");
      render();
      $("load-error").hidden = true;
      $("connection").className =
        "connection " + (data.demo ? "warning" : "live");
      $("connection").textContent = data.demo ? "Preview mode" : "Live updates";
      $("updated").textContent =
        "Updated " +
        new Date(data.timestamp || Date.now()).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        });
    } catch (error) {
      $("load-error").hidden = false;
      $("load-error").textContent =
        (data ? "Showing the last update. " : "") +
        error.message +
        " Use Refresh to try again.";
      $("connection").className = "connection warning";
      $("connection").textContent = "Updates paused";
      if (!data)
        for (const id of [
          "fleet-preview",
          "activity",
          "cold-chain",
          "fleet-table",
          "alerts-list",
        ])
          $(id).innerHTML = empty(
            "refresh",
            "We couldn’t load this yet.",
            "Check your connection, then refresh to try again.",
          );
    } finally {
      loading = false;
      $("refresh").disabled = false;
    }
  }
  $("refresh").onclick = refresh;
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 15000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  $("activity-tabs").onclick = (event) => {
    const b = event.target.closest("[data-activity]");
    if (!b) return;
    activity = b.dataset.activity;
    $("activity-tabs")
      .querySelectorAll("button")
      .forEach((t) => t.setAttribute("aria-pressed", String(t === b)));
    renderActivity();
  };
  $("fleet-filters").onclick = (event) => {
    const b = event.target.closest("[data-fleet]");
    if (!b) return;
    fleetFilter = b.dataset.fleet;
    $("fleet-filters")
      .querySelectorAll("button")
      .forEach((t) => t.setAttribute("aria-pressed", String(t === b)));
    renderFleet();
  };
  $("fleet-search").oninput = renderFleet;
  $("export").onclick = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      "nexora-operations-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    W.toast("Operations snapshot exported.");
  };
  function quickActions() {
    const dialog = W.dialog(
      "Keep things moving",
      `<p>Choose what you’d like to do.</p>${[
        [
          "ride",
          "car",
          "Estimate a ride",
          "Check the price before a customer books.",
        ],
        [
          "freight",
          "box",
          "Quote a delivery",
          "Price a freight or parcel shipment.",
        ],
        [
          "temperature",
          "temp",
          "Record a temperature",
          "Add a reading for a refrigerated shipment.",
        ],
        [
          "rebalance",
          "refresh",
          "Rebalance the fleet",
          "Review the current fleet allocation.",
        ],
      ]
        .map(
          ([action, glyph, title, desc]) =>
            `<button class="action-choice" data-action="${action}">${icon(glyph)}<span><strong>${title}</strong><small>${desc}</small></span></button>`,
        )
        .join("")}`,
    );
    dialog
      .querySelectorAll("[data-action]")
      .forEach((b) => (b.onclick = () => actionForm(b.dataset.action)));
  }
  function coordinates(prefix, title) {
    return `<fieldset><legend>${title}</legend><div class="form-grid"><label>Latitude<input name="${prefix}_lat" type="number" min="-90" max="90" step="any" placeholder="25.2048" required></label><label>Longitude<input name="${prefix}_lng" type="number" min="-180" max="180" step="any" placeholder="55.2708" required></label></div></fieldset>`;
  }
  function actionForm(kind) {
    if (kind === "rebalance") {
      const dialog = W.dialog(
        "Rebalance the fleet",
        `<p>Evaluate the available fleet against current demand. This creates an operations update with a recommended allocation.</p><p class="error-text" role="alert" id="action-error"></p><div id="action-result" role="status"></div><div class="dialog-actions"><button id="run-rebalance" class="primary">Run rebalance ${icon("arrow")}</button></div>`,
      );
      dialog.querySelector("#run-rebalance").onclick = async (e) => {
        e.currentTarget.disabled = true;
        try {
          if (!data || data.demo)
            throw new Error(
              "Connect to live operations before rebalancing the fleet.",
            );
          const result = await api("/fleet/rebalance", {});
          dialog.querySelector("#action-result").innerHTML =
            `<div class="result-box"><strong>${esc(number(result.drivers_rebalanced))} drivers recommended</strong><p>${esc(result.reasoning)}</p></div>`;
          await refresh();
        } catch (error) {
          dialog.querySelector("#action-error").textContent = error.message;
          dialog.querySelector("#run-rebalance").disabled = false;
        }
      };
      return;
    }
    if (kind === "temperature" && !(data?.cold_chain?.shipments || []).length) {
      W.dialog(
        "Record a temperature",
        empty(
          "temp",
          "No refrigerated shipments",
          "Start a refrigerated delivery to record and monitor its temperature.",
        ),
      );
      return;
    }
    const ride = kind === "ride",
      temperature = kind === "temperature";
    const fields = temperature
      ? `<label>Shipment<select name="delivery_id">${data.cold_chain.shipments.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(s.cargo || "Refrigerated shipment")}</option>`).join("")}</select></label><label>Temperature (°C)<input name="temperature_c" type="number" step="any" min="-100" max="100" required></label>${coordinates("sensor", "Sensor location")}`
      : `${ride ? '<label>Pickup address<input name="pickup_address" required placeholder="Street, building, or landmark"></label>' : ""}${coordinates("pickup", "Pickup coordinates")}${ride ? '<label>Destination address<input name="dropoff_address" required placeholder="Where is the customer going?"></label>' : ""}${coordinates("dropoff", "Destination coordinates")}<label>Service<select name="service_type">${(ride
          ? [
              ["taxi", "Standard ride"],
              ["medical", "Medical transport"],
              ["airport", "Airport transfer"],
            ]
          : [
              ["standard_parcel", "Standard parcel"],
              ["courier", "Courier"],
              ["bulk_freight", "Bulk freight"],
              ["cold_chain", "Cold chain"],
              ["oversized", "Oversized"],
              ["express_same_day", "Same-day express"],
            ]
        )
          .map(([value, label]) => `<option value="${value}">${label}</option>`)
          .join(
            "",
          )}</select></label>${ride ? "" : '<div class="form-grid"><label>Weight (kg)<input type="number" name="cargo_weight_kg" min="0.01" step="any" required></label><label>Volume (m³)<input type="number" name="cargo_volume_m3" min="0.001" step="any" required></label></div>'}`;
    const dialog = W.dialog(
      temperature
        ? "Record a temperature"
        : ride
          ? "Ride estimate"
          : "Freight quote",
      `<p>${temperature ? "Add an actual sensor reading and its location." : "Enter the route details to get a price. This creates an estimate; it does not book a job."}</p><form id="action-form" class="dialog-form">${fields}<p class="error-text" role="alert" id="action-error"></p><div class="dialog-actions"><button type="submit" class="primary">${temperature ? "Save reading" : "Get estimate"} ${icon("arrow")}</button></div></form><div id="action-result" role="status"></div>`,
    );
    dialog.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      const button = event.target.querySelector("button[type=submit]");
      button.disabled = true;
      dialog.querySelector("#action-error").textContent = "";
      dialog.querySelector("#action-result").innerHTML = "";
      try {
        if (temperature && (!data || data.demo))
          throw new Error(
            "Connect to live operations before recording readings.",
          );
        const body = Object.fromEntries(new FormData(event.target));
        for (const key of Object.keys(body))
          if (/_lat$|_lng$|_kg$|_m3$|^temperature_c$/.test(key))
            body[key] = Number(body[key]);
        if (temperature) {
          body.lat = body.sensor_lat;
          body.lng = body.sensor_lng;
          delete body.sensor_lat;
          delete body.sensor_lng;
        }
        if (!ride && !temperature)
          body.requires_refrigeration = body.service_type === "cold_chain";
        const result = await api(
          temperature
            ? "/cold-chain/telemetry"
            : ride
              ? "/trips/estimate"
              : "/b2b/quote",
          body,
        );
        dialog.querySelector("#action-result").innerHTML = temperature
          ? `<div class="result-box"><strong>Reading saved</strong><p>${esc(result.is_excursion ? "Temperature is outside the expected range. Review the cold-chain alert." : "The shipment reading has been updated.")}</p></div>`
          : `<div class="result-box"><small>${data?.demo ? "Preview estimate" : "Estimated price"} · USD</small><strong>${esc(money(ride ? result.price_estimate?.total_fare : result.breakdown?.total_fare))}</strong><p>${ride ? "Customers can book through the customer portal." : esc(human(result.recommended_vehicle)) + " · " + esc(result.distance_km) + " km · " + esc(result.estimated_transit_hours) + " hours estimated transit"}</p></div>`;
        if (temperature) await refresh();
      } catch (error) {
        const el = dialog.querySelector("#action-error");
        if (el) el.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
  }
  $("quick-actions").onclick = quickActions;
  $("rebalance").onclick = () => actionForm("rebalance");
  refresh();
})();
