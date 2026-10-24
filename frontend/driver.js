const TOKEN_KEY = "nexora_driver_token";
const NAME_KEY = "nexora_driver_name";
const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(
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
const money = (v) => `$${Number(v || 0).toFixed(2)}`;
const store = {
  get(k) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

let jobsTimer = null;
let locationTimer = null;
let locationBusy = false;
let manualLocation = false;
let online = false;
let podDeliveryId = null;
let signed = false;

const session = NexoraSession("nexora_driver", () => logout(true));
async function api(path, options = {}) {
  try {
    return await session.api(path, options);
  } catch (err) {
    if (err.status === 503 && path.startsWith("/driver/jobs"))
      showView("offline");
    throw err;
  }
}

function showView(name) {
  $("login-view").style.display = name === "login" ? "" : "none";
  $("offline-view").style.display = name === "offline" ? "" : "none";
  $("app-view").style.display = name === "app" ? "" : "none";
  if (name !== "app") clearInterval(jobsTimer);
}

async function login(e) {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("login-email").value.trim(),
        password: $("login-password").value,
      }),
    });
    if (data.user.role !== "driver") {
      session.save(data);
      session.logout();
      $("login-error").textContent = "This account is not a driver account.";
      return;
    }
    session.save(data);
    $("login-password").value = "";
    startApp();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
}

async function logout(expired = false) {
  const wasOnline = online,
    token = store.get(TOKEN_KEY);
  clearInterval(jobsTimer);
  clearInterval(locationTimer);
  if ($("pod-modal").open) closePodModal();
  online = false;
  showView("login");
  if (!expired)
    await Promise.allSettled([
      NexoraNotifications.disable(session.api),
      wasOnline && token
        ? fetch("/api/v1/driver/status", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + token,
            },
            body: JSON.stringify({ status: "offline" }),
            signal: AbortSignal.timeout(3000),
          })
        : Promise.resolve(),
    ]);
  session.logout();
}

let publicConfig = {};
$("enable-alerts").addEventListener("click", async () => {
  try {
    await NexoraNotifications.enable(session.api, publicConfig);
    $("notification-status").textContent =
      "Job alerts are on. Keep this page open while online to share your current location.";
  } catch (err) {
    $("notification-status").textContent = err.message;
  }
});
async function loadPayouts() {
  try {
    const data = await api("/driver/payouts");
    $("payout-onboard").hidden = !data.enabled || data.ready;
    $("payout-status").textContent = !data.enabled
      ? "Card payouts are not available yet. Cash fares are paid directly to you."
      : data.ready
        ? "Your payout account is ready. Completed card earnings transfer automatically; bank arrival follows your Stripe payout schedule."
        : "Complete your payout account setup to receive card earnings.";
  } catch (err) {
    $("payout-status").textContent = err.message;
  }
}
$("payout-onboard").addEventListener("click", async () => {
  const button = $("payout-onboard");
  button.disabled = true;
  try {
    const { url } = await api("/driver/payouts/onboard", {
      method: "POST",
      body: {},
    });
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      target.hostname !== "connect.stripe.com"
    )
      throw new Error("Unable to open payout setup.");
    location.assign(url);
  } catch (err) {
    $("payout-status").textContent = err.message;
    button.disabled = false;
  }
});

function renderOnline() {
  const btn = $("online-btn");
  btn.textContent = online ? "Online" : "Go online";
  btn.setAttribute("aria-pressed", String(online));
  btn.style.color = online ? "var(--success)" : "var(--text-muted)";
}

async function toggleOnline() {
  $("status-error").textContent = "";
  $("online-btn").disabled = true;
  try {
    if (!online) await updateLocation();
    const data = await api("/driver/status", {
      method: "POST",
      body: JSON.stringify({ status: online ? "offline" : "available" }),
    });
    online = data.status !== "offline";
    renderOnline();
    syncLocationTimer();
  } catch (err) {
    $("status-error").textContent = err.message;
  } finally {
    $("online-btn").disabled = false;
  }
}

async function updateLocation() {
  if (locationBusy) return;
  locationBusy = true;
  try {
    let position;
    const latValue = $("location-lat").value,
      lngValue = $("location-lng").value;
    if (manualLocation && latValue !== "" && lngValue !== "") {
      position = { lat: Number(latValue), lng: Number(lngValue) };
    } else {
      if (!navigator.geolocation)
        throw new Error(
          "Location is unavailable. Open “Location not working?” for alternatives.",
        );
      const current = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(
          resolve,
          () =>
            reject(
              new Error(
                "Allow location access, or open “Location not working?” for alternatives.",
              ),
            ),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
        ),
      );
      position = {
        lat: current.coords.latitude,
        lng: current.coords.longitude,
        accuracy_m: Math.min(32000, Math.round(current.coords.accuracy)),
      };
      $("location-lat").value = position.lat;
      $("location-lng").value = position.lng;
    }
    if (
      !Number.isFinite(position.lat) ||
      !Number.isFinite(position.lng) ||
      Math.abs(position.lat) > 90 ||
      Math.abs(position.lng) > 180
    )
      throw new Error("Enter valid latitude and longitude.");
    await api("/driver/location", {
      method: "POST",
      body: JSON.stringify(position),
    });
    $("location-message").textContent =
      "Location updated at " + new Date().toLocaleTimeString();
  } finally {
    locationBusy = false;
  }
}
function syncLocationTimer() {
  clearInterval(locationTimer);
  if (online)
    locationTimer = setInterval(
      () =>
        updateLocation().catch((err) => {
          $("location-message").textContent = err.message;
        }),
      15000,
    );
}
$("update-location").addEventListener("click", async () => {
  manualLocation =
    $("location-lat").value !== "" && $("location-lng").value !== "";
  try {
    await updateLocation();
  } catch (err) {
    $("location-message").textContent = err.message;
  }
});
$("device-location").addEventListener("click", async () => {
  manualLocation = false;
  $("device-location").disabled = true;
  try {
    await updateLocation();
  } catch (err) {
    $("location-message").textContent = err.message;
  } finally {
    $("device-location").disabled = false;
  }
});

async function loadEarnings() {
  try {
    const { earnings, freight } = await api("/driver/earnings?period=today");
    $("earnings-total").textContent = money(
      Number(earnings.total_earnings) + Number(freight.total_earnings),
    );
    $("earnings-trips").textContent = earnings.completed_trips;
    $("earnings-deliveries").textContent = freight.completed_deliveries;
    $("earnings-rating").textContent = earnings.avg_rating
      ? `${Number(earnings.avg_rating).toFixed(2)}`
      : "—";
  } catch {
    /* shown as dashes */
  }
}

// Which buttons a job shows depends on its status; each maps to a driver action endpoint.
const DELIVERY_ACTIONS = {
  pending: [
    ["accept", "Accept"],
    ["decline", "Decline"],
  ],
  pickup_scheduled: [["pickup", "Confirm pickup (PIN)"]],
  in_transit: [["pod", "Confirm delivery"]],
  out_for_delivery: [["pod", "Confirm delivery"]],
};
const TRIP_ACTIONS = {
  accepted: [
    ["accept", "Accept"],
    ["decline", "Decline"],
  ],
  driver_en_route: [["arrive", "I've arrived"]],
  arrived: [["start", "Start ride (rider PIN)"]],
  in_progress: [["complete", "Complete ride"]],
};

function jobCard(kind, job) {
  const actions =
    (kind === "delivery" ? DELIVERY_ACTIONS : TRIP_ACTIONS)[job.status] || [];
  const number = kind === "delivery" ? job.delivery_number : job.trip_number;
  const title =
    kind === "delivery"
      ? `${number}${job.cargo_description ? ` · ${job.cargo_description}` : ""}`
      : number;
  const buttons = actions
    .map(
      ([action, label], i) =>
        `<button class="btn-action ${i > 0 ? "btn-secondary" : ""}" data-kind="${kind}" data-id="${esc(job.id)}" data-action="${action}" data-cash="${job.payment_method === "cash"}" data-fare="${esc(money(job.total_fare))}">${esc(label)}</button>`,
    )
    .join("");
  return `
        <div class="job-card">
          <div class="job-badge-row">
            <div class="job-type-pill">${kind === "delivery" ? "Delivery" : "Ride"} · ${esc(job.status.replace(/_/g, " "))}</div>
            <div class="payout-pill">${money(job.total_fare)}</div>
          </div>
          <h3 style="font-size: 15px; font-weight: 700;">${esc(title)}</h3>
          <div class="address-flow">
            <div class="addr-point"><span>Pickup</span>${esc(job.pickup_address)}</div>
            <div class="addr-point"><span>Dropoff</span>${esc(job.dropoff_address)}</div>
          </div>
          ${buttons ? `<div class="btn-row">${buttons}</div>` : ""}
        </div>`;
}

async function loadJobs() {
  try {
    const { trips, deliveries, driver } = await api("/driver/jobs/current");
    if (driver) {
      const changed = online !== driver.is_online;
      online = driver.is_online;
      renderOnline();
      if (changed) syncLocationTimer();
      if (!driver.onboarding_completed)
        $("status-error").textContent =
          "Your account is waiting for admin approval.";
    }
    const cards = [
      ...trips.map((t) => jobCard("trip", t)),
      ...deliveries.map((d) => jobCard("delivery", d)),
    ];
    $("jobs").innerHTML = cards.length
      ? cards.join("")
      : '<div class="job-card notice"><strong>No active jobs</strong>Go online to receive ride and delivery offers.</div>';
  } catch (err) {
    $("jobs").innerHTML =
      `<div class="job-card notice"><strong>Could not load jobs</strong>${esc(err.message)}</div>`;
  }
}

$("jobs").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { kind, id, action } = btn.dataset;
  if (action === "pod")
    return openPodModal(id, btn.dataset.cash === "true", btn.dataset.fare);

  $("status-error").textContent = "";
  const body = {};
  if (action === "complete" && btn.dataset.cash === "true") {
    if (
      !(await NexoraUI.ask({
        title: "Confirm cash collection",
        message: `Have you collected ${btn.dataset.fare} in cash from the rider? Only confirm after receiving payment.`,
        confirm: "Cash collected",
      }))
    )
      return;
    body.cash_collected = true;
  }
  if (action === "pickup" || action === "start") {
    const otp = await NexoraUI.ask({
      title:
        action === "pickup" ? "Confirm package pickup" : "Start the journey",
      message:
        action === "pickup"
          ? "Ask the sender for their 6-digit pickup PIN after receiving the package."
          : "Ask your rider for their 4-digit PIN after they have checked your vehicle.",
      confirm: action === "pickup" ? "Confirm pickup" : "Start ride",
      input: true,
      digits: action === "pickup" ? 6 : 4,
    });
    if (!otp) return;
    body.otp = otp.trim();
  }
  btn.disabled = true;
  try {
    const base = kind === "delivery" ? "deliveries" : "trips";
    await api(`/driver/${base}/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    await Promise.all([loadJobs(), loadEarnings()]);
  } catch (err) {
    // Offers expire after a short window; a 404/409 usually means the job moved on.
    const stale = /not found|cannot/i.test(err.message);
    $("status-error").textContent = stale
      ? "That job is no longer available to you. The list has been refreshed."
      : err.message;
    btn.disabled = false;
    await loadJobs();
  }
});

// Signature pad
const canvas = $("sig-pad");
const ctx = canvas.getContext("2d");
let drawing = false;

function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = 140;
  ctx.strokeStyle = "#21634c";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
}
function point(e) {
  const rect = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return [src.clientX - rect.left, src.clientY - rect.top];
}
function startDraw(e) {
  e.preventDefault();
  drawing = true;
  ctx.beginPath();
  ctx.moveTo(...point(e));
}
function draw(e) {
  if (!drawing) return;
  e.preventDefault();
  ctx.lineTo(...point(e));
  ctx.stroke();
  signed = true;
}
function stopDraw() {
  drawing = false;
}
function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  signed = false;
}

canvas.addEventListener("mousedown", startDraw);
canvas.addEventListener("mousemove", draw);
window.addEventListener("mouseup", stopDraw);
canvas.addEventListener("touchstart", startDraw, { passive: false });
canvas.addEventListener("touchmove", draw, { passive: false });
window.addEventListener("touchend", stopDraw);

function openPodModal(deliveryId, isCash, fare) {
  $("pod-cash-row").hidden = !isCash;
  $("pod-cash").checked = false;
  $("pod-cash-label").textContent =
    `I collected ${fare} in cash from the recipient`;
  podDeliveryId = deliveryId;
  $("pod-otp").value = "";
  $("pod-recipient").value = "";
  $("pod-error").textContent = "";
  $("pod-modal").showModal();
  $("pod-otp").focus();
  resizeCanvas();
  clearCanvas();
}
function closePodModal() {
  $("pod-modal").close();
  podDeliveryId = null;
}

async function submitPod() {
  if (!$("pod-cash-row").hidden && !$("pod-cash").checked) {
    $("pod-error").textContent =
      "Collect the delivery fee and confirm cash collection.";
    return;
  }
  const otp = $("pod-otp").value.trim();
  const recipient = $("pod-recipient").value.trim();
  if (!/^\d{6}$/.test(otp)) {
    $("pod-error").textContent = "Enter the 6-digit PIN.";
    return;
  }
  if (!recipient) {
    $("pod-error").textContent = "Enter the recipient's name.";
    return;
  }
  if (!signed) {
    $("pod-error").textContent = "Ask the recipient to sign.";
    return;
  }

  $("pod-submit").disabled = true;
  try {
    await api(
      `/driver/deliveries/${encodeURIComponent(podDeliveryId)}/deliver`,
      {
        method: "POST",
        body: JSON.stringify({
          otp,
          recipient_name: recipient,
          cash_collected: $("pod-cash").checked,
          pod_signature: canvas.toDataURL("image/png"),
        }),
      },
    );
    closePodModal();
    await Promise.all([loadJobs(), loadEarnings()]);
  } catch (err) {
    $("pod-error").textContent = err.message;
  } finally {
    $("pod-submit").disabled = false;
  }
}

async function startApp() {
  $("driver-name").textContent = store.get(NAME_KEY) || "Driver";
  renderOnline();
  showView("app");
  publicConfig = await api("/config");
  await Promise.all([loadJobs(), loadEarnings(), loadPayouts()]);
  clearInterval(jobsTimer);
  jobsTimer = setInterval(() => {
    if (!document.hidden) loadJobs();
  }, 5000);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && store.get(TOKEN_KEY)) {
    loadJobs();
    if (online) updateLocation().catch(() => {});
  }
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && !store.get(TOKEN_KEY)) logout(true);
});
(async function init() {
  if (store.get(TOKEN_KEY)) return startApp();
  try {
    // Without a database there are no driver accounts, so skip the sign-in form.
    // A static host (no API) answers /ready with a non-JSON 404.
    const res = await fetch("/ready");
    const ready = await res.json().catch(() => null);
    if (!ready) {
      $("offline-text").textContent =
        "This preview has no backend server, so there are no driver accounts or jobs.";
      return showView("offline");
    }
    if (ready.checks && ready.checks.database !== "up")
      return showView("offline");
  } catch {
    /* fall through to login */
  }
  showView("login");
})();
