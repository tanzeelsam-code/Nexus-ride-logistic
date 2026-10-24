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
| AI engine | `ai_engine.py` | FastAPI deterministic baseline: proximity ranking, rate-card pricing, safety and cold chain; research models are isolated |
| Ops dashboards | `frontend/` | Static HTML + `nexora-client.js` (live data bridge, ops sign-in) |
| Android shell | `android/`, `scripts/build-apk.sh` | WebView wrapper around the dashboards |
| Cloudflare app | `cloudflare/worker.mjs` | Website, live API, authorized event polling and scheduled dispatch |
| Infra | `docker-compose.yml`, `nginx.conf`, `monitoring/` | Postgres, Redis, API, AI, Nginx, Prometheus, Grafana |
| Tests | `scripts/e2e.js`, `scripts/verify-all.sh` | See [Testing](#testing) |

## Live deployment: Supabase + Cloudflare

The live app is https://nexora-ride-logistic.tanzeelsam.workers.dev. Cloudflare serves the frontend and runs the existing Fastify API through its Node HTTP adapter. Supabase stores application data, sessions, refresh tokens, request locks, rate limits and the event outbox. No Redis, Containers or separate backend server is required for this deployment.

Cloudflare Hyperdrive `DATABASE` connects to Supabase project `ftghshvmcjxkshoenpmn` with a dedicated `nexora_backend` login. The origin uses `verify-full` TLS and the Supabase root CA; query caching is disabled for current driver and booking state. The login has application table access with RLS policies, and cannot create roles or bypass RLS. Browser roles cannot read the private runtime schema. Cloudflare secrets hold the JWT signing and optional integration keys; credentials must stay out of Git.

Passwords use bcrypt with cost 12 through Supabase pgcrypto. Browser sessions retain the existing API token format. Live notifications use authenticated `GET /api/v1/events?after=<cursor>` polling; customer and driver events are restricted to their own identities, and operations events require an operations role. Dispatch runs on a one-minute Cloudflare cron and during job polling. The standalone Node runtime still supports Socket.io and Redis for local development.

Deploy with `npm run deploy`. This installation can preview the Worker with `npm run preview:cloudflare`; `.env.cloudflare-local` configures the local Hyperdrive connection with certificate verification. Open `http://localhost:8787/?api=http://localhost:8787`. Verify `GET /api/v1/ready` reports `database` and `session_store` as `up`. The ignored `.env.nexora-admin` file holds this installation's operations login. Card authorization, capture and driver transfers require configured Stripe credentials and Connect onboarding. Pricing and cash booking run without an AI service; production quotes require a working Mapbox key. Worker Prometheus counters are scoped to an isolate; Cloudflare observability is the source for aggregate traffic.

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
pip install -r ai/requirements.txt
uvicorn ai_engine:app --port 8001
```

Open `frontend/index.html` through any static server (for example `cd frontend && python3 -m http.server 8099`) and add `?api=http://localhost:3000`. Set `OPS_AUTH_REQUIRED=true` on the API to see the ops sign-in flow.

## Running with Docker Compose

```bash
cp .env.example .env      # then edit every value
docker compose up -d      # postgres, redis, api, ai-engine, nginx, prometheus, grafana
```

- Dashboards: <http://localhost>, API through Nginx at `/api/v1/...`, Grafana <http://localhost:3001>.
- The API refuses to start in production with weak or missing secrets (`JWT_SECRET` ≥ 32 chars, explicit `ALLOWED_ORIGINS`, and Stripe keys when card payments are enabled). Stripe test keys can be used in staging; never use live payment credentials for automated tests.
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

## Booking, maps, notifications and payments

Customers select pickup and destination through address search or map pins. The fare preview includes provider road distance, traffic-based duration and route geometry. A signed quote holds the fare for five minutes and binds the stops, addresses, passenger count and service. Booking retries use an idempotency key; a database lock prevents concurrent active rides for the same customer. The customer map follows the assigned driver and hides locations older than two minutes. Customers can cancel and rate completed rides.

The driver portal uses the same light green visual style, refreshes expired sessions, supports opt-in job alerts, and provides Stripe Connect payout setup. Both customer and driver sessions discard responses issued before sign-out.

### Integration setup before deployment

Apply `supabase/migrations/20261019085513_booking_payments_notifications.sql` before deploying this Worker version. Local Node startup applies this idempotent migration to its configured development database. It adds server-only payment, settlement, durable-job and push-subscription tables with RLS. The dedicated `nexora_backend` role receives the required grants; browser roles receive none.

Configure these variables using your deployment's secret management:

| Variable | Purpose |
|---|---|
| `MAPBOX_API_KEY` | Server-side token for Geocoding v6 and Directions. Permanent geocoding must be enabled because booking addresses are stored. |
| `CARD_PAYMENTS_ENABLED` | Explicitly set `true` after configuring and testing Stripe; default `false`. |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Matching Stripe account and mode. Only the publishable key is exposed to the browser. |
| `STRIPE_CONNECT_COUNTRY` | Two-letter country for driver Express account onboarding; choose a supported country for your business. |
| `PUBLIC_APP_URL` | Canonical HTTPS origin for Stripe onboarding return links and delivery tracking. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push keys and a `mailto:` contact or HTTPS contact URL. Generate a key pair with `npx web-push generate-vapid-keys`; keep the private key secret. |
| `AI_DISPATCH_ENABLED` | Defaults to `false`. Only an independently evaluated service returning `model_status: validated` can influence dispatch. The included baseline never claims this status. |

Mapbox errors do not silently turn into fictional road routes. Unconfigured **development** instances provide explicitly labelled approximate previews; production returns an unavailable message until maps work. Search uses [permanent Geocoding results](https://docs.mapbox.com/api/search/geocoding/) and road routes use [Directions](https://docs.mapbox.com/api/navigation/directions/).

Card checkout uses Stripe's Payment Element and customer authentication. [Manual capture](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method) holds the quoted fare before dispatch. Completion commits a capture job with the ride and payment record. Capture success creates one settlement for the driver's 80% share; a Connect transfer uses the original charge as its source. Cash earnings are not credited again as an electronic payout. Failed/no-driver bookings and abandoned quotes release unused authorizations. Transfer retries reconcile existing provider transfers as well as using stable idempotency keys.

Webhooks are signature-verified and queued durably; a failed handler can be retried rather than permanently discarded as a duplicate. Node processes jobs every two seconds; Workers use bounded post-request work and the existing one-minute cron. Jobs have leases and exponential retry delays. Exhausted jobs and blocked settlements appear in operations alerts. Driver bank arrival follows their Stripe payout schedule. Refunds/disputes block pending transfers and require operations review of transfers already sent; this release does not initiate automatic refunds or transfer reversals.

Push notifications require explicit browser opt-in and HTTPS (localhost works for development). They use encrypted payloads, provider endpoint validation, short expiry for job offers, and automatic removal of expired subscriptions. They contain no addresses or pickup PINs. Sign-out unsubscribes the device. Browsers without Web Push continue using on-screen polling. Drivers must keep the portal open to send current location; a web page cannot guarantee background GPS.

## Account recovery

Open `/account-recovery.html` while you know your current password and generate a single-use offline recovery code. Save it privately; only its SHA-256 hash is stored. A new code replaces the old one. Reset requires the saved code and a new password of 12–72 UTF-8 bytes; successful reset atomically consumes the code, increments the account session version and removes push subscriptions. Access tokens, refresh tokens and Node socket sessions are revoked. There is no email reset provider configured; users without a code and without their current password cannot self-recover. Recovery-code generation shares the login lockout counter, and dependency outages return 503 without revoking valid browser credentials. Admin bootstrap only creates missing accounts and never resets credentials on restart. Standalone deployments must set `TRUST_PROXY` to their actual reverse proxy IP/CIDR if they need forwarded client IPs; the default trusts none. Cloudflare supplies and overwrites its own forwarding header.

## Remaining product limits

- **No trained-model claims.** Untrained architectures live in `ai/research_models.py` and are never imported by the serving runtime. Dispatch uses proximity, pricing uses published rates with neutral surge, and demand forecasts explicitly report unavailable. Real trip history, training and independent evaluation are still required before introducing learned models.
- **Freight uses cash on delivery.** Customers review a signed, five-minute quote before booking. Drivers confirm cash collection, recipient name and signature; completion writes one receipt atomically. Database-backed request identities prevent duplicate deliveries if the response cache is lost. Card capture/Connect settlement covers rides only. Cash earnings are never sent again as electronic payouts. Operators reconcile the platform commission collected by cash drivers manually. Legacy deliveries with no payment method require operations reconciliation.
- **Integration activation needs real credentials.** Automated payment tests use a fake Stripe provider and real isolated PostgreSQL/Redis. They do not certify live card processing, bank payouts, Mapbox account permissions or push delivery on physical devices.
- **Mobile and operations.** The Android APK is a WebView wrapper. SMS, background GPS, driver document uploads and scheduled bookings are not implemented. Scheduled requests are rejected explicitly. `ride.html` redirects to the customer portal; `freight.html` is the real delivery portal. Shipment insurance is unavailable in production until an actual insurance arrangement is implemented.
- **Launch validation.** Run a Stripe sandbox/SCA test, physical-device push test, and a supervised field pilot before public launch. Cloudflare supplies HTTPS; standalone Docker deployments still require a TLS terminator.

Additional regression checks:

```bash
npm run verify                 # syntax, session/tracking/provider unit tests and smoke checks
npm run test:integrations       # pure tests; DB suite is skipped unless explicitly enabled
# Isolated test DB/Redis only; defaults are ports 55439/56389 with test-only credentials.
NEXORA_TEST_DATABASE=isolated npm run test:integrations
python3 -m unittest discover -s scripts -p 'test_ai_baseline.py'
npm run deploy:check            # Worker packaging; does not deploy
```

### Customer, driver, and administrator access

Start at https://nexora-ride-logistic.tanzeelsam.workers.dev/ and choose a role.

- **Customer:** Open `/customer.html`, expand **Create a customer account**, register, and request a ride. Search and select pickup/destination addresses, or place pins on the map. Review the fare before confirming. Pay with cash or an enabled card integration. Follow the driver on the map and share the pickup PIN only when the correct driver arrives.
- **Delivery:** Sign in at `/freight.html` with your customer account. Select both addresses, enter sender/recipient contacts and package details, review the fare, and confirm. The recipient pays cash at delivery. Your delivery history contains tracking links, handoff PINs and paid receipts.
- **Driver:** Register at `/driver-register.html`, including your vehicle. Sign in at `/driver.html`. An administrator must approve your registration before **Go online** works. Allow location access so dispatch can find you near a pickup. Accept an offer, mark arrival, enter the rider's pickup PIN, and complete the ride. Delivery jobs also support pickup/drop-off PINs and proof of delivery.
- **Admin:** Sign in at `/admin.html` with the local credentials in `.env.nexora-admin`. Review pending drivers and choose **Approve driver**. Open the operations dashboard at `/ops.html` for fleet and dispatch information. Public registration creates customer or driver accounts, never admin accounts.

To try all roles yourself, use separate browser profiles or tabs and different customer/driver email addresses and phone numbers. Register the driver, approve them as admin, and put them online near your customer pickup before requesting a ride. With no nearby available driver, the request fails after the dispatch timeout.

## Release deployment (2026-10-24)

Apply pending additive migrations before deploying the Worker. The backend role must retain its server-only RLS policies and sequence privileges. Back up the schema and migration history before changing the production database. Never run `scripts/e2e.js` against production: the Node-mode test deliberately resets active jobs in its isolated database.

Node 22.23.4 or 24.22.1+ within the supported major is required; `.nvmrc`, CI and containers use 22.23.4. Wrangler's transitive Undici is pinned to patched 7.30.1 until its upstream pin is updated. Run `npm audit` and the Python dependency audit again before each release.

The public config reports `booking_available`, `card_payments`, `push_notifications` and the recovery method. With no maps token, production booking fails closed and the customer portals explain that new bookings are unavailable. A configured token must still pass real geocoding and road-route checks. Do not enable cards until credentials, webhook delivery, Connect onboarding and sandbox SCA/capture/refund handling have been verified.

Before opening paid bookings: confirm the launch country, currency, service area, published fare rates, legal business/support contact, privacy/terms, driver screening and a supervised field pilot. These operator decisions are not inferred from the development environment.
