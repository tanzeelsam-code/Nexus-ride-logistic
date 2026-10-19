-- Cover foreign keys flagged by the Supabase performance advisor (unindexed_foreign_keys).
-- Speeds up joins on these columns and avoids sequential scans on the child table
-- when the referenced row is updated or deleted. No behaviour change.
CREATE INDEX IF NOT EXISTS idx_users_referred_by            ON public.users(referred_by);
CREATE INDEX IF NOT EXISTS idx_trips_vehicle                ON public.trips(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_trips_zone                   ON public.trips(zone_id);
CREATE INDEX IF NOT EXISTS idx_trips_surge_zone             ON public.trips(surge_zone_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_vehicle           ON public.deliveries(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_zone              ON public.deliveries(zone_id);
CREATE INDEX IF NOT EXISTS idx_safety_incidents_trip        ON public.safety_incidents(trip_id);
CREATE INDEX IF NOT EXISTS idx_safety_incidents_delivery    ON public.safety_incidents(delivery_id);
CREATE INDEX IF NOT EXISTS idx_safety_incidents_driver      ON public.safety_incidents(driver_id);
CREATE INDEX IF NOT EXISTS idx_safety_incidents_customer    ON public.safety_incidents(customer_id);
CREATE INDEX IF NOT EXISTS idx_safety_incidents_resolved_by ON public.safety_incidents(resolved_by);
CREATE INDEX IF NOT EXISTS idx_driver_documents_verified_by ON public.driver_documents(verified_by);
CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_vehicle  ON public.vehicle_maintenance(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor             ON public.audit_logs(actor_id);
