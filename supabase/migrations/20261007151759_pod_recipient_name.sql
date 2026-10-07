-- Proof of delivery: record who signed for a delivery.
ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS dropoff_recipient_name VARCHAR(100);
