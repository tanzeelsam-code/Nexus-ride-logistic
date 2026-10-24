-- Additive: existing sessions remain valid until an account is recovered.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS recovery_code_hash text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
