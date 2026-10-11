-- Server-only sessions, atomic rate limits, and authorized event delivery.
CREATE SCHEMA IF NOT EXISTS nexora_private;
REVOKE ALL ON SCHEMA nexora_private FROM PUBLIC, anon, authenticated;
CREATE TABLE nexora_private.runtime_kv (
  key text PRIMARY KEY,
  value text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX runtime_kv_expiry ON nexora_private.runtime_kv(expires_at);
CREATE TABLE nexora_private.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audience text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_audience_cursor ON nexora_private.events(audience,id);
CREATE INDEX events_expiry ON nexora_private.events(created_at);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexora_backend') THEN
    CREATE ROLE nexora_backend NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE nexora_backend SET search_path=public,extensions;
GRANT USAGE ON SCHEMA public,extensions,nexora_private TO nexora_backend;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public,nexora_private TO nexora_backend;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public,nexora_private TO nexora_backend;
GRANT EXECUTE ON FUNCTION public.update_updated_at(), public.update_driver_rating() TO nexora_backend;
-- The API performs JWT ownership/role checks. This trusted login is never a Data API role.
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','nexora_private') LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',t.schemaname,t.tablename);
    EXECUTE format('CREATE POLICY nexora_server ON %I.%I TO nexora_backend USING (true) WITH CHECK (true)',t.schemaname,t.tablename);
  END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA nexora_private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA nexora_private FROM PUBLIC,anon,authenticated;
