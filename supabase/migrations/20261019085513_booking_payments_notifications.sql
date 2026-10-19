-- Durable booking, payment settlement and opt-in Web Push infrastructure.
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS route_geometry jsonb;
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS route_source text;
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS route_duration_minutes numeric(10,2);
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS route_distance_km numeric(10,3);
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
ALTER TABLE public.drivers ADD COLUMN IF NOT EXISTS stripe_account_id text;
CREATE UNIQUE INDEX IF NOT EXISTS trips_payment_intent_unique ON public.trips(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS drivers_stripe_account_unique ON public.drivers(stripe_account_id) WHERE stripe_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.booking_payments (
  intent_id text PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.users(id),
  quote_hash text NOT NULL,
  amount_cents integer NOT NULL CHECK(amount_cents>0),
  currency text NOT NULL,
  trip_id uuid UNIQUE REFERENCES public.trips(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_payments_customer ON public.booking_payments(customer_id);
CREATE INDEX IF NOT EXISTS booking_payments_abandoned ON public.booking_payments(expires_at) WHERE trip_id IS NULL;

CREATE TABLE IF NOT EXISTS public.driver_settlements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id uuid NOT NULL UNIQUE REFERENCES public.trips(id),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  amount_cents integer NOT NULL CHECK(amount_cents>0),
  currency text NOT NULL,
  charge_id text NOT NULL,
  transfer_id text UNIQUE,
  transferred_at timestamptz,
  blocked_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_settlements_driver ON public.driver_settlements(driver_id);

CREATE TABLE IF NOT EXISTS public.background_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS background_jobs_pending ON public.background_jobs(kind,available_at,id) WHERE completed_at IS NULL AND attempts<12;

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  subscription jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON public.push_subscriptions(user_id);

-- The browser uses the authenticated API; no direct Data API access is needed.
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['booking_payments','driver_settlements','background_jobs','push_subscriptions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',relation);
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon,authenticated',relation);
    END IF;
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='nexora_backend') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO nexora_backend',relation);
      IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=relation AND policyname='nexora_server') THEN
        EXECUTE format('CREATE POLICY nexora_server ON public.%I TO nexora_backend USING(true) WITH CHECK(true)',relation);
      END IF;
    END IF;
  END LOOP;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='nexora_backend') THEN
    GRANT USAGE,SELECT ON SEQUENCE public.driver_settlements_id_seq,public.background_jobs_id_seq,public.push_subscriptions_id_seq TO nexora_backend;
  END IF;
END $$;
