# NEXUS Logistics

Two businesses on one platform, sharing one dispatch and AI backbone (**NEXUS CORE**):

- **NEXUS RIDE** – an Uber-style taxi service: riders request trips, nearby drivers are matched and accept, the trip runs through pickup, ride and completion, fares are split 80/20 between driver and platform, and the rider rates the driver.
- **NEXUS FREIGHT** – parcels, pallets and cold-chain cargo: shippers book a delivery, a freight-capable driver is matched, pickup and drop-off are confirmed with one-time codes, and refrigerated loads are monitored by IoT temperature telemetry.

Drivers can serve rides, freight, or both (`ride` / `freight` / `both` mode).

## What is in the repo

| Part | Path | Notes |
|---|---|---|
| REST + Socket.io API | `backend_api.js` | Fastify, PostgreSQL/PostGIS/TimescaleDB, Redis |
| Database schema | `database_schema.sql` | Loaded automatically by the Postgres container |
| AI engine | `ai_engine.py` | FastAPI + PyTorch: dispatch ranking, pricing, ETA, fraud, safety, demand, cold chain |
| Ops dashboards | `frontend/` | Static HTML + `nexus-client.js` (live data bridge, ops sign-in) |
| Android shell | `android/`, `scripts/build-apk.sh` | WebView wrapper around the dashboards |
| Edge preview | `cloudflare/worker.mjs` | Serves the dashboards as a labelled demo (no backend) |
| Infra | `docker-compose.yml`, `nginx.conf`, `monitoring/` | Postgres, Redis, API, AI, Nginx, Prometheus, Grafana |
| Tests | `scripts/e2e.js`, `scripts/verify-all.sh` | See [Testing](#testing) |

## Quick start (local development)

You need Node 20+, PostgreSQL with PostGIS and TimescaleDB, and Redis. The easiest way to get the databases is Docker:

```bash
docker run -d --name nexus-pg -p 5432:5432 \
  -e POSTGRES_USER=nexus -e POSTGRES_PASSWORD=nexus_secret -e POSTGRES_DB=nexusdb \
  -v "$PWD/database_schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro" \
  timescale/timescaledb-ha:pg15-latest
docker run -d --name nexus-redis -p 6379:6379 redis:7-alpine redis-server --requirepass redis_secret

npm install
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='choose-a-long-password' npm start
```

In development the API uses the defaults `nexus_secret` / `redis_secret` for the two databases. With no database reachable it still starts, serves pricing and the flagged sample-data dashboard, and returns `503` for anything that needs storage.

Optional AI engine (the API falls back to a built-in rate card and nearest-driver ranking without it):

```bash
pip install -r ai/requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
uvicorn ai_engine:app --port 8001
```

Open `frontend/index.html` through any static server (for example `cd frontend && python3 -m http.server 8099`) and add `?api=http://localhost:3000`. Set `OPS_AUTH_REQUIRED=true` on the API to see the ops sign-in flow.

## Running with Docker Compose

```bash
cp .env.example .env      # then edit every value
docker compose up -d      # postgres, redis, api, ai-engine, nginx, prometheus, grafana
```

- Dashboards: <http://localhost>, API through Nginx at `/api/v1/...`, Grafana <http://localhost:3001>.
- The API refuses to start in production with weak or missing secrets (`JWT_SECRET` ≥ 32 chars, live Stripe key, explicit `ALLOWED_ORIGINS`). For a local compose run with Stripe test keys, set `NODE_ENV=development` in `.env`.
- Kafka/Zookeeper are optional and off by default (`docker compose --profile streaming up`). The API does not use them yet.
- Database, Redis, API, Prometheus and Grafana ports are bound to `127.0.0.1`. The AI engine is only reachable inside the compose network. Put a TLS terminator in front of Nginx for real deployments (`ssl/` is empty).

## Configuration

| Variable | Purpose |
|---|---|
| `DB_*`, `REDIS_*` | Connections (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`) |
| `JWT_SECRET` | Token signing key (required in production) |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins (required in production) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Creates or resets the admin account at startup (12+ chars). There is no default admin |
| `OPS_AUTH_REQUIRED` | Require an ops/admin token for ops endpoints and the ops socket (default `true` in production) |
| `IOT_DEVICE_KEY` | Shared key for cold-chain sensors (`x-device-key` header) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Payments |
| `AI_ENGINE_URL` | AI engine base URL (default `http://localhost:8001`) |
| `DISPATCH_TIMEOUT_SEC`, `DRIVER_RESPONSE_TIMEOUT_SEC` | How long a request waits for a driver / how long a driver has to answer an offer (defaults 30 / 20) |

## How it works

**Ride:** `requested → searching → accepted (offered) → driver_en_route → arrived → in_progress → completed` (or `cancelled` / `failed`).
**Freight:** `pending (unassigned or offered) → pickup_scheduled → in_transit → delivered`.

- Dispatch finds online, approved drivers inside the search radius with PostGIS, ranks them with the AI engine (nearest-first if it is down), and reserves one atomically so a driver is never offered two jobs.
- A driver who declines, or does not answer in time, is skipped and the next-best driver is offered the job. With nobody available a ride ends as `failed` after the dispatch timeout.
- Every state change is a guarded `UPDATE ... WHERE status = ...`, so retries and double taps are safe. The same machine backs both the REST routes and the socket events.
- The rider's 4-digit trip code starts the ride; freight uses a pickup code and a drop-off code.
- `Idempotency-Key` on `POST /trips` and `POST /deliveries` replays the original response instead of double-booking.

### API summary (`/api/v1`)

| Who | Endpoints |
|---|---|
| Public | `GET /health` `GET /ready` `GET /metrics` · `POST /trips/estimate` · `POST /b2b/quote` · `GET /track/:slug` |
| Auth | `POST /auth/register` `login` `refresh` `logout` · `POST /drivers/register` |
| Rider / shipper | `POST /trips` `GET /trips` `GET /trips/:id` `POST /trips/:id/cancel` `POST /trips/:id/rate` · `POST /deliveries` `GET /deliveries/:id` `POST /deliveries/:id/cancel` · `POST /payments/setup-intent` |
| Driver | `POST /driver/status` `location` `mode` · `GET /driver/earnings` `GET /driver/jobs/current` · `POST /driver/trips/:id/{accept,decline,arrive,start,complete}` · `POST /driver/deliveries/:id/{accept,decline,pickup,deliver}` |
| Ops / admin | `GET /ops/overview` `GET /fleet/drivers` `POST /fleet/rebalance` `GET /cold-chain/shipments` `GET /admin/dashboard` `GET /admin/drivers` `POST /admin/drivers/:id/approve` (`suspend`: admin only) |
| Sensors | `POST /cold-chain/telemetry` (device key or ops/driver token) |
| Stripe | `POST /webhooks/stripe` (signature verified, events stored once) |

Socket.io: clients send `auth {token}`; ops dashboards send `ops:join {token}`. Drivers receive `trip:new_request` / `delivery:new_request`; riders receive `trip:*` and `driver:location`.

## Testing

```bash
npm test          # end-to-end: needs Postgres (schema loaded) + Redis, starts the API itself
npm run verify    # no-database smoke check
```

`npm test` runs 100+ checks over auth and token rotation, RBAC, driver onboarding and approval, dispatch, decline and timeout handling, the full ride and delivery lifecycles, idempotency, cold-chain alerts, Stripe webhook signatures and the Socket.io streams. It passes with the AI engine running and with it offline. CI (`.github/workflows/ci.yml`) runs the same suite.

## Known limitations

These are not built yet; do not rely on them in production:

- **Card charging.** Cash trips settle; card trips record a pending payment but nothing captures it. `setup-intent` and the Stripe webhook are in place, but there is no payment-method storage or charge-on-completion step, and no driver payout job.
- **The AI models are untrained.** `DispatchBrainNet`, `ETAProphetNet` and `DemandOracleNet` run with random weights, so their scores, ETAs and forecasts are placeholders. Dispatch effectively relies on proximity; pricing uses the rate card plus a heuristic surge.
- **No rider or driver apps.** The repo has the API and the ops dashboards. `ride.html` and `freight.html`, and the revenue chart, top-drivers list and AI panels on `index.html`, still show static sample content. The Android APK wraps those dashboards.
- **Routing and ETA** use straight-line distance × 1.3, not a maps provider.
- No push/SMS notifications, promo codes, driver document uploads, or TLS termination.
