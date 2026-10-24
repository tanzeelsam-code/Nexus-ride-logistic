ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS request_key text;
ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS request_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_customer_request_unique
  ON public.deliveries(customer_id,request_key) WHERE request_key IS NOT NULL;
