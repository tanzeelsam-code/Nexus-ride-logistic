# NEXUS Production Gap Audit and Build Plan

## Snapshot (Current State)
- Product quality: strong prototype/demo with clear domain coverage for ride + freight.
- Production readiness: not ready yet due to infrastructure blockers, mock-data frontend, and missing operational controls.
- Estimated readiness score: 5/10 for prototype, 2/10 for production.

## Critical Findings (P0)
1. API healthcheck mismatch blocks healthy deploys.
   - Docker healthcheck uses `GET /health` but API exposes no `/health` route.
   - Evidence: `docker-compose.yml` healthcheck for `api`; no `/health` in `backend_api.js`.
2. Nginx API path rewrite likely breaks backend routes.
   - `location /api/ { proxy_pass http://backend/; }` strips `/api` prefix; backend routes are `/api/v1/...`.
   - Evidence: `nginx.conf`, `backend_api.js` route list.
3. Monitoring stack references missing files.
   - Compose mounts `./monitoring/prometheus.yml`, but file does not exist.
   - Evidence: `docker-compose.yml`, empty `monitoring/` file listing.
4. Web frontend is mock-driven, not connected to live API/socket.
   - Dashboard renders `mockTrips`, `mockDeliveries`, `mockAlerts` with timers.
   - Evidence: `frontend/index.html`.
5. Secrets/defaults are unsafe for production.
   - Hard fallback secrets in API config and test-like values in `.env`.
   - Evidence: `backend_api.js` config defaults, `.env`.
6. Refresh-token lifecycle is incomplete.
   - API issues refresh tokens but has no refresh endpoint and no rotation/revocation model.
   - Evidence: `/api/v1/auth/login` and `/api/v1/auth/register` in `backend_api.js`.
7. Stripe webhook verification likely unreliable.
   - Uses `req.rawBody` without explicit raw body parser wiring.
   - Evidence: `/api/v1/webhooks/stripe` in `backend_api.js`.
8. AI dispatch still uses simulated drivers.
   - Dispatch endpoint creates `mock_drivers` instead of querying real nearby drivers.
   - Evidence: `/dispatch` in `ai_engine.py`.

## High-Impact Findings (P1)
1. No automated test suite (API, AI, frontend, integration).
2. No deployment pipeline or environment promotion flow.
3. Limited auditability for admin actions and support actions.
4. No idempotency keys for booking/payment endpoints.
5. CORS policy is currently broad and incompatible with strict credentialed usage.
6. Socket ops alert room (`ops:alerts`) has no explicit join flow for ops clients.

## Phased Execution Plan

## Phase 0: Stabilize Foundation (Week 1)
Goal: make local/prod deployment correct and observable.

Work items:
- Add `GET /health` and `GET /ready` in API; wire Redis/DB checks.
- Fix Nginx proxy to preserve `/api/v1/*` routes.
- Add missing Prometheus config and at least one Grafana dashboard provisioning file.
- Add structured request IDs and propagate to logs.
- Lock environment config: remove dangerous defaults, fail-fast on missing secrets in production.

Exit criteria:
- `docker compose up` reaches healthy state for API/AI/monitoring.
- API reachable through Nginx at `/api/v1/...`.
- Basic metrics visible in Grafana.

## Phase 1: Production MVP Core (Weeks 2-4)
Goal: convert prototype into reliable transactional system.

Work items:
- Implement refresh token endpoint + rotation + revocation store.
- Add idempotency keys for `POST /trips`, `POST /deliveries`, payment flows.
- Harden Stripe webhook path (raw body parsing + event persistence + replay protection).
- Move trip/delivery state transitions behind validated finite state machine.
- Add exception workflows: no-driver-found, timeout, reassignment, trip failure.
- Connect frontend dashboard to real API + Socket.io (remove primary mock paths).

Exit criteria:
- End-to-end real flow: register/login -> create trip/delivery -> dispatch -> location updates -> completion.
- Duplicate requests do not double-charge or double-create orders.
- Dashboard displays real active counts and alerts.

## Phase 2: Operational Scale and Trust (Weeks 5-10)
Goal: make operations safe at volume.

Work items:
- RBAC hardening (admin/ops/support/customer/driver scopes at route level).
- Audit logging for sensitive actions (payouts, refunds, manual overrides, bans).
- Alerting rules (SLA breach, SOS, API latency, dispatch failure rate).
- Retry + circuit breaker patterns for AI and payment dependencies.
- Backpressure controls for driver location ingest and socket fanout.
- Add automated tests:
  - API: auth, booking, payment, state transitions.
  - AI: deterministic unit tests for dispatch/pricing guardrails.
  - Integration: core happy path + failure path.

Exit criteria:
- 99.9% API uptime in staging soak test.
- Incident response playbook tested for SOS and payment outage scenarios.
- Test pipeline gating merges.

## Phase 3: AI and Revenue Expansion (Weeks 11-16)
Goal: layer growth features on stable core.

Work items:
- Replace AI mock driver inputs with PostGIS/Redis-backed candidate retrieval.
- Add model telemetry and drift tracking for dispatch/ETA.
- Roll out B2B freight APIs, invoicing, and account-level controls.
- Add customer-facing tracking portal and branded share links.
- Add fintech primitives (instant payout ledger, settlement reconciliation).

Exit criteria:
- AI decisions are traceable with measurable lift vs baseline.
- B2B freight contracts can onboard through API + dashboard.
- Finance reconciliation closes daily without manual spreadsheet work.

## 30-Day Implementation Backlog (Recommended)
Week 1:
- [ ] `/health` + `/ready` endpoints
- [ ] Nginx `/api` proxy fix
- [ ] Prometheus/Grafana config files
- [ ] Secrets policy and startup validation

Week 2:
- [ ] Refresh token endpoint + token rotation
- [ ] Idempotency middleware
- [ ] Stripe webhook raw-body and event table

Week 3:
- [ ] State machine for trip/delivery statuses
- [ ] Driver reassignment timeout flow
- [ ] Ops alert room join/auth flow in Socket.io

Week 4:
- [ ] Replace mock dashboard data with API + sockets
- [ ] Add API integration tests and smoke tests
- [ ] Staging soak test + runbook rehearsal

## KPI Targets After Phase 2
- Trip creation success rate: > 99.5%
- Dispatch success within SLA: > 95%
- Payment webhook reconciliation lag: < 2 minutes
- Duplicate booking/payment incidents: 0
- P95 API latency: < 300ms for non-AI endpoints
- Dashboard data staleness: < 5 seconds

## Immediate Next Build Order
1. Deployment correctness fixes (health, nginx, monitoring).
2. Auth/payment reliability (refresh, idempotency, webhook hardening).
3. Real-time and dashboard integration with actual backend data.
4. Test and observability gate before any major new features.
