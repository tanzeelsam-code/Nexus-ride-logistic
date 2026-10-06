/**
 * NEXUS LOGISTICS — Real-Time Operations Bridge & Live HUD
 * =========================================================
 * Connects frontend dashboards (index.html, ride.html, freight.html)
 * to Fastify REST API, Socket.io real-time stream, and AI CORE.
 */

(function () {
  'use strict';

  // Config & API Endpoint Resolution
  const params = new URLSearchParams(window.location.search);
  const DEFAULT_PORT = 3000;
  const isLocalHost = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
  const API_HOST = params.get('api') || (window.location.protocol === 'file:'
    ? 'http://localhost:3000'
    : isLocalHost && window.location.port && window.location.port !== '3000'
      ? `${window.location.protocol}//${window.location.hostname}:${DEFAULT_PORT}`
      : window.location.origin);


  const state = {
    connected: false,
    backendMode: 'CHECKING',
    activeTripsCount: 0,
    activeDeliveriesCount: 0,
    onlineDrivers: 0,
    socket: null,
    fleetData: null,
    coldChainData: null,
    diurnalData: null,
    alertsQueue: [],
    authRequired: false,
  };

  // Shared with the dashboard page: it renders live data when `live` is true, sample data otherwise.
  window.NexusLive = { live: false, overview: null };
  function publishLive(data) {
    window.NexusLive.live = !!data && !data.demo;
    window.NexusLive.overview = data || null;
    window.dispatchEvent(new CustomEvent('nexus:data'));
  }

  // Ops sign-in: the ops endpoints and socket require an ops/admin token.
  const TOKEN_KEY = 'nexus_ops_token';
  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  function setToken(token) {
    try { token ? sessionStorage.setItem(TOKEN_KEY, token) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
  }
  function apiFetch(path, options = {}) {
    const token = getToken();
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${API_HOST}${path}`, { ...options, headers });
  }
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ─── STYLES INJECTION ──────────────────────────────────────────────
  const hudStyles = document.createElement('style');
  hudStyles.textContent = `
    /* NEXUS OPERATIONS LIVE HUD */
    #nexus-hud-bar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 38px;
      background: rgba(8, 10, 15, 0.95);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(0, 212, 255, 0.2);
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      font-family: 'Barlow', -apple-system, sans-serif;
      font-size: 11px;
      color: #94a3b8;
    }
    body { padding-top: 38px !important; }
    
    .hud-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .hud-brand {
      font-family: 'Barlow Mono', monospace;
      font-weight: 700;
      letter-spacing: 1.5px;
      color: #00d4ff;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .hud-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 999px;
      font-family: 'Barlow Mono', monospace;
      font-size: 10px;
      font-weight: 600;
    }
    .hud-pill.live {
      background: rgba(0, 255, 136, 0.15);
      border: 1px solid rgba(0, 255, 136, 0.35);
      color: #00ff88;
    }
    .hud-pill.demo {
      background: rgba(255, 149, 0, 0.15);
      border: 1px solid rgba(255, 149, 0, 0.35);
      color: #ff9500;
    }
    .hud-diurnal {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.04);
      padding: 3px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .hud-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .hud-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #f1f5f9;
      padding: 4px 10px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
    }
    .hud-btn:hover {
      background: rgba(0, 212, 255, 0.2);
      border-color: #00d4ff;
      color: #00d4ff;
    }
    .hud-btn.primary {
      background: rgba(0, 212, 255, 0.15);
      border-color: rgba(0, 212, 255, 0.4);
      color: #00d4ff;
    }
    .hud-btn.primary:hover {
      background: #00d4ff;
      color: #06080d;
    }
    .hud-btn.cold {
      background: rgba(56, 189, 248, 0.15);
      border-color: rgba(56, 189, 248, 0.4);
      color: #38bdf8;
    }
    .hud-btn.cold:hover {
      background: #38bdf8;
      color: #06080d;
    }

    /* TOAST ALERTS */
    #nexus-toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 100000;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 380px;
    }
    .nexus-toast {
      background: rgba(15, 23, 42, 0.95);
      backdrop-filter: blur(12px);
      border-radius: 8px;
      padding: 12px 16px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
      border-left: 4px solid #00d4ff;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.6);
      animation: nexusSlideIn 0.25s ease-out;
      color: #e2e8f0;
      font-family: 'Barlow', sans-serif;
    }
    .nexus-toast.critical {
      border-left-color: #ef4444;
      background: rgba(35, 12, 16, 0.95);
    }
    .nexus-toast.warning {
      border-left-color: #f59e0b;
      background: rgba(35, 24, 12, 0.95);
    }
    .nexus-toast.success {
      border-left-color: #10b981;
    }
    .nexus-toast-title {
      font-weight: 700;
      font-size: 13px;
      color: #f8fafc;
      margin-bottom: 2px;
    }
    .nexus-toast-desc {
      font-size: 11px;
      color: #94a3b8;
      line-height: 1.4;
    }

    /* MODAL STYLES */
    .nexus-modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(6px);
      z-index: 100001;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .nexus-modal {
      background: #0d121c;
      border: 1px solid rgba(0, 212, 255, 0.25);
      border-radius: 12px;
      width: 480px;
      max-width: 90vw;
      padding: 24px;
      color: #e2e8f0;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 30px rgba(0, 212, 255, 0.15);
      font-family: 'Barlow', sans-serif;
    }
    .nexus-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 12px;
    }
    .nexus-modal-title {
      font-size: 16px;
      font-weight: 700;
      color: #f8fafc;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nexus-modal-close {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 18px;
      cursor: pointer;
    }
    .nexus-form-group {
      margin-bottom: 14px;
    }
    .nexus-form-label {
      display: block;
      font-size: 11px;
      color: #94a3b8;
      margin-bottom: 6px;
      font-family: 'Barlow Mono', monospace;
    }
    .nexus-form-input, .nexus-form-select {
      width: 100%;
      background: #151d2d;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 9px 12px;
      color: #f8fafc;
      font-size: 13px;
      box-sizing: border-box;
      outline: none;
    }
    .nexus-form-input:focus, .nexus-form-select:focus {
      border-color: #00d4ff;
    }
    .nexus-modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 20px;
      padding-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    @keyframes nexusSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(hudStyles);

  // ─── HUD DOM CREATION ──────────────────────────────────────────────
  const hud = document.createElement('div');
  hud.id = 'nexus-hud-bar';
  hud.innerHTML = `
    <div class="hud-left">
      <div class="hud-brand">
        <span style="font-size:14px">⚡</span> NEXUS OPS
      </div>
      <div id="nexus-status-pill" class="hud-pill demo">
        <span id="nexus-status-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff9500"></span>
        <span id="nexus-status-text">CONNECTING...</span>
      </div>
      <div class="hud-diurnal">
        <span>🔄 Cross-Fleet Utilization:</span>
        <strong id="hud-diurnal-metric" style="color:#00d4ff">48% Rides · 38% Freight · 14% Cold</strong>
      </div>
      <div style="font-family:'Barlow Mono', monospace; font-size:10px; color:#64748b" id="hud-deadhead">
        Deadhead Reduction: <span style="color:#00ff88;font-weight:700">-34.8%</span>
      </div>
    </div>

    <div class="hud-actions">
      <button class="hud-btn primary" id="btn-request-ride">🚕 Request Ride</button>
      <button class="hud-btn" id="btn-quote-freight">📦 B2B Freight Quote</button>
      <button class="hud-btn cold" id="btn-cold-chain">🌡️ Ingest IoT Temp</button>
      <button class="hud-btn" id="btn-rebalance-fleet">🔄 AI Rebalance</button>
    </div>
  `;
  document.body.prepend(hud);

  // Toast Container
  const toastContainer = document.createElement('div');
  toastContainer.id = 'nexus-toast-container';
  document.body.appendChild(toastContainer);

  // ─── TOAST NOTIFICATION HELPER ─────────────────────────────────────
  function showToast(title, desc, type = 'info', icon = 'ℹ️') {
    const toast = document.createElement('div');
    toast.className = `nexus-toast ${type}`;
    toast.innerHTML = `
      <div style="font-size:18px">${icon}</div>
      <div style="flex:1">
        <div class="nexus-toast-title">${title}</div>
        <div class="nexus-toast-desc">${desc}</div>
      </div>
      <button style="background:none;border:none;color:#64748b;cursor:pointer;font-size:14px" onclick="this.parentElement.remove()">✕</button>
    `;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, 6000);
  }

  // ─── API CLIENT & SYNC ─────────────────────────────────────────────
  async function checkBackend() {
    try {
      const res = await apiFetch('/api/v1/ops/overview');
      if (res.status === 401 || res.status === 403) {
        setToken(null);
        state.connected = false;
        state.authRequired = true;
        state.backendMode = 'AUTH';
        updateHUDStatus(false, 'SIGN IN REQUIRED · OPS ACCESS');
        if (!state.loginShown) { state.loginShown = true; promptOpsLogin(); }
        return false;
      }
      if (res.ok) {
        const data = await res.json();
        state.connected = true;
        state.authRequired = false;
        state.backendMode = data.demo ? 'SIMULATION' : 'LIVE';
        state.fleetData = data.fleet;
        state.coldChainData = data.cold_chain;
        state.diurnalData = data.diurnal;

        updateHUDStatus(!data.demo, data.demo ? 'API UP · SAMPLE FLEET (no database)' : `API LIVE (${API_HOST.replace(/^https?:\/\//, '')})`);
        applyLiveDataToDashboard(data);
        publishLive(data);
        return true;
      }
    } catch (e) {
      // Backend not running on this host
    }

    state.connected = false;
    state.backendMode = 'SIMULATION';
    publishLive(null);
    updateHUDStatus(false, 'DEMO PREVIEW · SAMPLE DATA');
    return false;
  }

  function updateHUDStatus(isLive, label) {
    const pill = document.getElementById('nexus-status-pill');
    const dot = document.getElementById('nexus-status-dot');
    const text = document.getElementById('nexus-status-text');

    if (!pill || !dot || !text) return;
    if (isLive) {
      pill.className = 'hud-pill live';
      dot.style.background = '#00ff88';
      text.textContent = label;
    } else {
      pill.className = 'hud-pill demo';
      dot.style.background = '#ff9500';
      text.textContent = label;
    }
  }

  function applyLiveDataToDashboard(data) {
    if (!data) return;

    // Update KPI counters across all dashboard variations
    const elemActiveTrips = document.getElementById('k-active') || document.getElementById('active-trips-count');
    if (elemActiveTrips && data.metrics?.active_trips !== undefined) {
      elemActiveTrips.textContent = data.metrics.active_trips;
    }

    const elemOnlineDrivers = document.getElementById('k-drivers') || document.getElementById('online-drivers-count');
    if (elemOnlineDrivers && data.fleet?.online_total !== undefined) {
      elemOnlineDrivers.textContent = data.fleet.online_total;
    }

    const elemETA = document.getElementById('k-eta');
    if (elemETA && data.metrics?.avg_eta_minutes) {
      elemETA.textContent = data.metrics.avg_eta_minutes.toFixed(1);
    }

    // Diurnal HUD metrics
    const diurnalMetric = document.getElementById('hud-diurnal-metric');
    if (diurnalMetric && data.fleet && data.fleet.online_total > 0) {
      const total = data.fleet.online_total;
      const ridePct = Math.round(((data.fleet.ride_only || 0) / total) * 100);
      const freightPct = Math.round(((data.fleet.freight_only || 0) / total) * 100);
      const dualPct = 100 - ridePct - freightPct;
      diurnalMetric.textContent = `🚕 ${ridePct}% Rides · 📦 ${freightPct}% Freight · 🔀 ${dualPct}% Dual-mode`;
    }

    // Update live alert stream if alerts exist
    if (data.alerts && data.alerts.length > 0 && typeof window.renderLivePanel === 'function') {
      window.mockAlerts = data.alerts;
    }
  }

  // ─── WEBSOCKET SETUP ───────────────────────────────────────────────
  function initSocket() {
    function connectSocket() {
      if (typeof io !== 'function') return;
      try {
        const socket = io(API_HOST, { transports: ['websocket', 'polling'], timeout: 3000 });
        state.socket = socket;

        socket.on('connect', () => {
          socket.emit('ops:join', { token: getToken() });
          updateHUDStatus(true, `LIVE STREAM CONNECTED`);
        });

        socket.on('ops:error', () => {
          updateHUDStatus(false, 'LIVE STREAM DENIED · SIGN IN AGAIN');
        });

        socket.on('ops:joined', (info) => {
          showToast('NEXUS CORE Connected', 'Real-time telemetry and ops alert stream active.', 'success', '🟢');
        });

        socket.on('ops:heartbeat', (data) => {
          if (data && data.drivers) {
            state.fleetData = data;
            if (window.NexusLive.overview) {
              window.NexusLive.overview.fleet = { ...window.NexusLive.overview.fleet, drivers: data.drivers };
              window.dispatchEvent(new CustomEvent('nexus:data'));
            }
          }
        });

        socket.on('cold_chain:alert', (alert) => {
          showToast(alert.title, alert.desc, 'critical', '🌡️');
          if (typeof window.renderLivePanel === 'function') {
            window.mockAlerts = [alert, ...(window.mockAlerts || [])];
          }
        });

        socket.on('fleet:rebalanced', (data) => {
          showToast('Diurnal Fleet Rebalance', data.reasoning, 'info', '🔄');
        });

        socket.on('fleet:mode_updated', (data) => {
          showToast('Driver Mode Updated', `Driver ${data.driver_id} switched operating mode to: ${data.mode.toUpperCase()}`, 'info', '🚕');
        });

        socket.on('disconnect', () => {
          updateHUDStatus(false, 'DEMO SIMULATION (Stream Reconnecting)');
        });
      } catch (err) {
        // Socket error, fallback to polling
      }
    }

    if (typeof io === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://cdn.socket.io/4.7.2/socket.io.min.js';
      script.onload = connectSocket;
      document.head.appendChild(script);
    } else {
      connectSocket();
    }
  }

  // ─── MODAL CONTROLS ────────────────────────────────────────────────
  function showModal(title, icon, bodyHtml, onConfirm, confirmText = 'Submit') {
    const backdrop = document.createElement('div');
    backdrop.className = 'nexus-modal-backdrop';
    backdrop.innerHTML = `
      <div class="nexus-modal">
        <div class="nexus-modal-header">
          <div class="nexus-modal-title"><span>${icon}</span> ${title}</div>
          <button class="nexus-modal-close" onclick="this.closest('.nexus-modal-backdrop').remove()">✕</button>
        </div>
        <div class="nexus-modal-body">
          ${bodyHtml}
        </div>
        <div class="nexus-modal-footer">
          <button class="hud-btn" onclick="this.closest('.nexus-modal-backdrop').remove()">Cancel</button>
          <button class="hud-btn primary" id="nexus-modal-confirm">${confirmText}</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.querySelector('#nexus-modal-confirm').onclick = () => {
      onConfirm(backdrop);
    };
  }

  // Prevent the preview from claiming that an operation was performed.
  document.addEventListener('click', (event) => {
    const action = event.target.closest('#btn-request-ride, #btn-quote-freight, #btn-cold-chain, #btn-rebalance-fleet');
    if (action && !state.connected) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.authRequired) { promptOpsLogin(); return; }
      showToast('Demo preview', 'Sample data only. Connect the backend to book rides, quote freight, or update the fleet.', 'info', 'ℹ️');
    }
  }, true);

  function promptOpsLogin() {
    showModal(
      'Operations Sign-in',
      '🔐',
      `
      <div class="nexus-form-group">
        <label class="nexus-form-label">Ops / admin email</label>
        <input class="nexus-form-input" id="ops-email" type="email" autocomplete="username" />
      </div>
      <div class="nexus-form-group">
        <label class="nexus-form-label">Password</label>
        <input class="nexus-form-input" id="ops-pass" type="password" autocomplete="current-password" />
      </div>
      <div id="ops-login-error" style="font-size:11px;color:#ff6b6b;min-height:14px"></div>
    `,
      async (modal) => {
        const errBox = modal.querySelector('#ops-login-error');
        try {
          const res = await fetch(`${API_HOST}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: modal.querySelector('#ops-email').value, password: modal.querySelector('#ops-pass').value }),
          });
          const data = await res.json();
          if (!res.ok) { errBox.textContent = data.error || 'Sign-in failed'; return; }
          if (!['admin', 'ops'].includes(data.user?.role)) { errBox.textContent = 'This account has no operations access.'; return; }
          setToken(data.token);
          modal.remove();
          state.loginShown = false;
          if (await checkBackend()) {
            if (state.socket) state.socket.disconnect();
            initSocket();
          }
        } catch {
          errBox.textContent = 'Could not reach the API.';
        }
      },
      'Sign in'
    );
  }

  // ─── ACTIONS WIRE-UP ───────────────────────────────────────────────
  document.getElementById('btn-request-ride').onclick = () => {
    showModal(
      'Price a NEXUS RIDE trip',
      '🚕',
      `
      <div class="nexus-form-group">
        <label class="nexus-form-label">Pickup Address</label>
        <input class="nexus-form-input" id="r-from" value="Times Square, New York" />
      </div>
      <div class="nexus-form-group">
        <label class="nexus-form-label">Destination</label>
        <input class="nexus-form-input" id="r-to" value="JFK International Airport" />
      </div>
      <div class="nexus-form-group">
        <label class="nexus-form-label">Service Type</label>
        <select class="nexus-form-select" id="r-type">
          <option value="taxi">Standard Sedan (4 seats)</option>
          <option value="luxury">NEXUS Black / Luxury</option>
          <option value="suv">SUV XL (6 seats)</option>
          <option value="medical">Medical Priority Transport</option>
          <option value="airport">Airport Shuttle</option>
        </select>
      </div>
    `,
      async (modal) => {
        const from = modal.querySelector('#r-from').value;
        const to = modal.querySelector('#r-to').value;
        const type = modal.querySelector('#r-type').value;

        modal.remove();

        try {
          const res = await apiFetch('/api/v1/trips/estimate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pickup_lat: 40.7580,
              pickup_lng: -73.9855,
              pickup_address: from,
              dropoff_lat: 40.6413,
              dropoff_lng: -73.7781,
              dropoff_address: to,
              service_type: type
            })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Estimate failed');
          const est = data.price_estimate;
          showToast(
            `Fare estimate: $${est.total_fare}`,
            `${esc(from)} → ${esc(to)} · surge ×${est.surge_multiplier}. Riders book from the rider app; this console only prices trips.`,
            'success',
            '🚕'
          );
        } catch (err) {
          showToast('Estimate failed', esc(err.message || 'Could not reach the pricing service.'), 'critical', '⚠️');
        }
      },
      'Get fare estimate'
    );
  };

  document.getElementById('btn-quote-freight').onclick = () => {
    showModal(
      'B2B Freight Instant Quote & Book',
      '📦',
      `
      <div class="nexus-form-group">
        <label class="nexus-form-label">Service Category</label>
        <select class="nexus-form-select" id="f-service">
          <option value="standard_parcel">Standard Parcel Van (5-50 kg)</option>
          <option value="courier">Express Motorcycle Courier (<5 kg)</option>
          <option value="cold_chain">❄️ Cold-Chain Refrigerated Logistics</option>
          <option value="bulk_freight">Bulk Freight (Pallets / Heavy Truck)</option>
          <option value="express_same_day">Guaranteed Same-Day Urgent</option>
        </select>
      </div>
      <div class="nexus-form-group">
        <label class="nexus-form-label">Cargo Weight (kg)</label>
        <input class="nexus-form-input" id="f-weight" type="number" value="75" />
      </div>
      <div class="nexus-form-group">
        <label class="nexus-form-label">Declared Value ($ USD)</label>
        <input class="nexus-form-input" id="f-val" type="number" value="2500" />
      </div>
    `,
      async (modal) => {
        const service = modal.querySelector('#f-service').value;
        const weight = Number(modal.querySelector('#f-weight').value);
        const val = Number(modal.querySelector('#f-val').value);

        modal.remove();
        showToast('Calculating AI Freight Quote...', 'Evaluating volumetric bin-packing and vehicle constraints...', 'info', '🧠');

        try {
          const res = await fetch(`${API_HOST}/api/v1/b2b/quote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pickup_lat: 40.7128,
              pickup_lng: -74.0060,
              dropoff_lat: 40.7580,
              dropoff_lng: -73.9855,
              service_type: service,
              cargo_weight_kg: weight,
              cargo_value: val,
              requires_refrigeration: service === 'cold_chain',
              insurance_requested: true
            })
          });

          if (!res.ok) throw new Error((await res.json()).error || 'Quote failed');
          const q = await res.json();
          showToast(
            `Freight Quote Ready: $${q.breakdown.total_fare}`,
            `Vehicle: ${esc(q.recommended_vehicle.toUpperCase())} · Distance: ${q.distance_km} km · ETA: ${q.estimated_transit_hours} hrs.`,
            'success',
            '📦'
          );
        } catch (err) {
          showToast('Quote failed', esc(err.message || 'Could not reach the quoting service.'), 'critical', '⚠️');
        }
      },
      'Get Instant SLA Quote'
    );
  };

  document.getElementById('btn-cold-chain').onclick = () => {
    showModal(
      'Simulate IoT Cold-Chain Sensor Telemetry',
      '🌡️',
      `
      <div class="nexus-form-group">
        <label class="nexus-form-label">Monitored Shipment</label>
        <select class="nexus-form-select" id="cc-shipment">
          <option value="DEL-44200">DEL-44200 (Biological Vaccines — Target: 2°C–6°C)</option>
          <option value="DEL-44207">DEL-44207 (Fresh Seafood/Dairy — Target: 0°C–4°C)</option>
        </select>
      </div>
      <div class="nexus-form-group">
        <label class="nexus-form-label">Sensor Temperature Reading (°C)</label>
        <input class="nexus-form-input" id="cc-temp" type="number" step="0.1" value="11.8" />
        <div style="font-size:10px;color:#94a3b8;margin-top:4px">Tip: Enter > 6.0°C to simulate an automated excursion alert.</div>
      </div>
      <div class="nexus-form-group">
        <label class="nexus-form-label">Sensor Battery Level</label>
        <input class="nexus-form-input" id="cc-bat" type="number" value="78" />
      </div>
    `,
      async (modal) => {
        const id = modal.querySelector('#cc-shipment').value;
        const temp = parseFloat(modal.querySelector('#cc-temp').value);
        const bat = parseInt(modal.querySelector('#cc-bat').value);
        modal.remove();

        try {
          const res = await apiFetch('/api/v1/cold-chain/telemetry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              delivery_id: id,
              temperature_c: temp,
              battery_pct: bat,
              seal_intact: true
            })
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || 'Telemetry rejected');
          if (result.is_excursion) {
            showToast('🚨 EXCURSION DETECTED', esc(result.alert.desc), 'critical', '🌡️');
          } else {
            showToast('Sensor Telemetry Ingested', `Temperature ${temp}°C within the shipment's safe range.`, 'success', '❄️');
          }
        } catch (err) {
          showToast('Telemetry failed', esc(err.message || 'Could not reach the API.'), 'critical', '⚠️');
        }
      },
      'Broadcast Sensor Reading'
    );
    // Offer the shipments that are actually being monitored right now.
    apiFetch('/api/v1/cold-chain/shipments').then((r) => r.ok ? r.json() : null).then((data) => {
      const select = document.getElementById('cc-shipment');
      if (!select || !data || !data.shipments.length) return;
      select.innerHTML = data.shipments.map((sh) =>
        `<option value="${esc(sh.id)}">${esc(sh.id)} (${esc(sh.cargo || 'cargo')}${sh.min_temp_c != null ? ` — Target: ${esc(sh.min_temp_c)}°C–${esc(sh.max_temp_c)}°C` : ''})</option>`
      ).join('');
    }).catch(() => {});
  };

  document.getElementById('btn-rebalance-fleet').onclick = async () => {
    showToast('Executing AI Rebalancer...', 'Analyzing diurnal demand curves between rides and freight...', 'info', '🧠');
    try {
      const res = await apiFetch('/api/v1/fleet/rebalance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rebalance failed');
      showToast('Fleet Rebalanced', esc(data.reasoning), 'success', '🔄');
    } catch (err) {
      showToast('Rebalance failed', esc(err.message || 'Could not reach the API.'), 'critical', '⚠️');
    }
  };

  // ─── INITIALIZATION ────────────────────────────────────────────────
  checkBackend().then((connected) => { if (connected) initSocket(); });

  // Refresh KPIs every 10 seconds (also recovers from a dropped connection)
  setInterval(() => { checkBackend(); }, 10000);
})();
