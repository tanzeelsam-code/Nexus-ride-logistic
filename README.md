# NEXORA Logistics

Two businesses on one platform, sharing one dispatch and AI backbone (**NEXORA CORE**):

- **NEXORA RIDE** – an Uber-style taxi service: riders request trips, nearby drivers are matched and accept, the trip runs through pickup, ride and completion, fares are split 80/20 between driver and platform, and the rider rates the driver.
- **NEXORA FREIGHT** – parcels, pallets and cold-chain cargo: shippers book a delivery, a freight-capable driver is matched, pickup and drop-off are confirmed with one-time codes, and refrigerated loads are monitored by IoT temperature telemetry.

Drivers can serve rides, freight, or both (`ride` / `freight` / `both` mode).

## What is in the repo

| Part | Path | Notes |
|---|---|---|
| REST API | `backend_api.js`, `cloudflare/` | Cloudflare Workers + Supabase PostgreSQL/PostGIS |
| Database schema | `database_schema.sql` | Loaded automatically by the Postgres container |
| AI engine | `ai_engine.py` | FastAPI + PyTorch: dispatch ranking, pricing, ETA, fraud, safety, demand, cold chain |
| Ops dashboards | `frontend/` | Static HTML + `nexora-client.js` (live data bridge, ops sign-in) |
| Android shell | `android/`, `scripts/build-apk.sh` | WebView wrapper around the dashboards |
| Cloudflare app | `cloudflare/worker.mjs` | Website, live API, authorized event polling and scheduled dispatch |
| Infra | `docker-compose.yml`, `nginx.conf`, `monitoring/` | Postgres, Redis, API, AI, Nginx, Prometheus, Grafana |
| Tests | `scripts/e2e.js`, `scripts/verify-all.sh` | See [Testing](#testing) |

## Live deployment: Supabase + Cloudflare

The live app is https://nexora-ride-logistic.tanzeelsam.workers.dev. Cloudflare serves the frontend and runs the existing Fastify API through its Node HTTP adapter. Supabase stores application data, sessions, refresh tokens, request locks, rate limits and the event outbox. No Redis, Containers or separate backend server is required for this deployment.

Cloudflare Hyperdrive `DATABASE` connects to Supabase project `ftghshvmcjxkshoenpmn` with a dedicated `nexora_backend` login. The origin uses `verify-full` TLS and the Supabase root CA; query caching is disabled for current driver and booking state. The login has application table access with RLS policies, and cannot create roles or bypass RLS. Browser roles cannot read the private runtime schema. Cloudflare secrets hold the JWT signing and optional integration keys; credentials must stay out of Git.

Passwords use bcrypt with cost 12 through Supabase pgcrypto. Browser sessions retain the existing API token format. Live notifications use authenticated `GET /api/v1/events?after=<cursor>` polling; customer and driver events are restricted to their own identities, and operations events require an operations role. Dispatch runs on a one-minute Cloudflare cron and during job polling. The standalone Node runtime still supports Socket.io and Redis for local development.

Deploy with `npm run deploy`. This installation can preview the Worker with `npm run preview:cloudflare`; `.env.cloudflare-local` configures the local Hyperdrive connection with certificate verification. Open `http://localhost:8787/?api=http://localhost:8787`. Verify `GET /api/v1/ready` reports `database` and `session_store` as `up`. The ignored `.env.nexora-admin` file holds this installation's operations login. Payment capture still requires valid Stripe credentials; pricing and cash booking flows run without a separate AI service. Worker Prometheus counters are scoped to an isolate; Cloudflare observability is the source for aggregate traffic.

Run the existing end-to-end suite against a Worker with `E2E_WORKER=true E2E_BASE_URL=<app URL>` and the installation's `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `IOT_DEVICE_KEY`, and `STRIPE_WEBHOOK_SECRET`. This mode checks HTTP events instead of Socket.io and does not reset other users' records. Tests create users with `@nexora.test` addresses; use only a designated test workflow.

## Quick start (local development)

You need Node 22+, PostgreSQL with PostGIS and TimescaleDB, and Redis. The easiest way to get the databases is Docker:

```bash
docker run -d --name nexora-pg -p 5432:5432 \
  -e POSTGRES_USER=nexus -e POSTGRES_PASSWORD=nexus_secret -e POSTGRES_DB=nexusdb \
  -v "$PWD/database_schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro" \
  timescale/timescaledb-ha:pg15-latest
docker run -d --name nexora-redis -p 6379:6379 redis:7-alpine redis-server --requirepass redis_secret

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
- **Web portals are available; native apps are not.** Customers can book rides at `customer.html`, drivers can register and manage jobs at `driver.html`, and administrators can approve drivers at `admin.html`. `ride.html` and `freight.html`, and some charts and AI panels on `ops.html`, still show static sample content. The Android APK is a WebView wrapper.
- **Routing and ETA** use straight-line distance × 1.3, not a maps provider.
- No push/SMS notifications, promo codes, driver document uploads, or TLS termination.

### Customer, driver, and administrator access

Start at https://nexora-ride-logistic.tanzeelsam.workers.dev/ and choose a role.

- **Customer:** Open `/customer.html`, expand **Create a customer account**, register, and request a ride. Enter pickup/destination addresses and coordinates; address search is not yet implemented. The pickup location button can fill the pickup coordinates with permission. Current bookings use cash. Follow ride status and share the pickup PIN only when the driver arrives.
- **Driver:** Register at `/driver-register.html`, including your vehicle. Sign in at `/driver.html`. An administrator must approve your registration before **Go online** works. Allow location access so dispatch can find you near a pickup. Accept an offer, mark arrival, enter the rider's pickup PIN, and complete the ride. Delivery jobs also support pickup/drop-off PINs and proof of delivery.
- **Admin:** Sign in at `/admin.html` with the local credentials in `.env.nexora-admin`. Review pending drivers and choose **Approve driver**. Open the operations dashboard at `/ops.html` for fleet and dispatch information. Public registration creates customer or driver accounts, never admin accounts.

To try all roles yourself, use separate browser profiles or tabs and different customer/driver email addresses and phone numbers. Register the driver, approve them as admin, and put them online near your customer pickup before requesting a ride. With no nearby available driver, the request fails after the dispatch timeout.
