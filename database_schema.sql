-- ============================================================
-- NEXUS LOGISTICS — COMPLETE DATABASE SCHEMA
-- PostgreSQL 15 + TimescaleDB Extension
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";          -- Geospatial
CREATE EXTENSION IF NOT EXISTS "timescaledb";      -- Time-series
CREATE EXTENSION IF NOT EXISTS "pg_trgm";          -- Fuzzy search
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE user_role AS ENUM ('customer', 'driver', 'admin', 'ops', 'support');
CREATE TYPE vehicle_type AS ENUM (
  'sedan', 'hatchback', 'suv', 'luxury', 'van',
  'truck_small', 'truck_medium', 'truck_large',
  'refrigerated', 'motorcycle', 'bicycle'
);
CREATE TYPE trip_status AS ENUM (
  'requested', 'searching', 'accepted', 'driver_en_route',
  'arrived', 'in_progress', 'completed', 'cancelled', 'failed'
);
CREATE TYPE delivery_status AS ENUM (
  'pending', 'pickup_scheduled', 'picked_up', 'in_transit',
  'out_for_delivery', 'delivered', 'failed_delivery',
  'returned', 'cancelled'
);
CREATE TYPE payment_status AS ENUM ('pending', 'authorized', 'captured', 'failed', 'refunded', 'disputed');
CREATE TYPE payment_method AS ENUM ('card', 'wallet', 'cash', 'corporate', 'crypto');
CREATE TYPE driver_status AS ENUM ('offline', 'available', 'on_trip', 'on_break', 'suspended');
CREATE TYPE document_status AS ENUM ('pending', 'verified', 'rejected', 'expired');
CREATE TYPE service_type AS ENUM ('taxi', 'freight', 'medical', 'airport', 'courier', 'cold_chain');
CREATE TYPE incident_severity AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE notification_channel AS ENUM ('push', 'sms', 'email', 'in_app', 'whatsapp');

-- ============================================================
-- USERS TABLE
-- ============================================================

CREATE TABLE users (
  id                    UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  external_id           VARCHAR(50) UNIQUE,                          -- e.g. "USR-20240001"
  role                  user_role NOT NULL DEFAULT 'customer',
  email                 VARCHAR(255) UNIQUE NOT NULL,
  phone                 VARCHAR(20) UNIQUE NOT NULL,
  phone_verified        BOOLEAN DEFAULT FALSE,
  email_verified        BOOLEAN DEFAULT FALSE,
  first_name            VARCHAR(100) NOT NULL,
  last_name             VARCHAR(100) NOT NULL,
  display_name          VARCHAR(150),
  avatar_url            TEXT,
  date_of_birth         DATE,
  gender                CHAR(1),
  preferred_language    CHAR(5) DEFAULT 'en',
  password_hash         TEXT NOT NULL,
  salt                  TEXT NOT NULL,
  mfa_enabled           BOOLEAN DEFAULT FALSE,
  mfa_secret            TEXT,
  
  -- Address
  default_home_lat      DECIMAL(10,7),
  default_home_lng      DECIMAL(10,7),
  default_work_lat      DECIMAL(10,7),
  default_work_lng      DECIMAL(10,7),
  
  -- Account
  is_active             BOOLEAN DEFAULT TRUE,
  is_verified           BOOLEAN DEFAULT FALSE,
  is_banned             BOOLEAN DEFAULT FALSE,
  ban_reason            TEXT,
  ban_expires_at        TIMESTAMP WITH TIME ZONE,
  
  -- Loyalty
  nexus_points          INTEGER DEFAULT 0,
  tier                  VARCHAR(20) DEFAULT 'bronze',               -- bronze, silver, gold, platinum
  
  -- Preferences
  preferred_payment     payment_method DEFAULT 'card',
  notifications_enabled JSONB DEFAULT '{"push": true, "sms": true, "email": true}',
  
  -- Metadata
  signup_source         VARCHAR(50),                                 -- web, ios, android, referral
  referral_code         VARCHAR(20) UNIQUE,
  referred_by           UUID REFERENCES users(id),
  
  -- Timestamps
  last_login_at         TIMESTAMP WITH TIME ZONE,
  last_login_ip         INET,
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deleted_at            TIMESTAMP WITH TIME ZONE                    -- soft delete
);

CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_referral ON users(referral_code);

-- ============================================================
-- DRIVERS TABLE (extends users)
-- ============================================================

CREATE TABLE drivers (
  id                      UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id                 UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  driver_number           VARCHAR(30) UNIQUE NOT NULL,              -- DRV-20240001
  
  -- Status & Availability
  status                  driver_status DEFAULT 'offline',
  is_online               BOOLEAN DEFAULT FALSE,
  current_location        GEOGRAPHY(POINT, 4326),
  current_heading         SMALLINT,                                 -- 0-360 degrees
  current_speed_kmh       DECIMAL(5,2),
  location_updated_at     TIMESTAMP WITH TIME ZONE,
  
  -- Ratings
  rating_overall          DECIMAL(3,2) DEFAULT 0.00,
  rating_count            INTEGER DEFAULT 0,
  rating_punctuality      DECIMAL(3,2) DEFAULT 0.00,
  rating_cleanliness      DECIMAL(3,2) DEFAULT 0.00,
  rating_driving          DECIMAL(3,2) DEFAULT 0.00,
  rating_communication    DECIMAL(3,2) DEFAULT 0.00,
  
  -- Performance
  total_trips             INTEGER DEFAULT 0,
  completed_trips         INTEGER DEFAULT 0,
  cancelled_trips         INTEGER DEFAULT 0,
  acceptance_rate         DECIMAL(5,2) DEFAULT 100.00,
  completion_rate         DECIMAL(5,2) DEFAULT 100.00,
  total_km_driven         DECIMAL(12,2) DEFAULT 0,
  total_earnings          DECIMAL(12,2) DEFAULT 0,
  
  -- Service Capabilities
  service_types           service_type[] DEFAULT '{taxi}',
  can_carry_pets          BOOLEAN DEFAULT FALSE,
  speaks_languages        CHAR(5)[] DEFAULT '{en}',
  
  -- Schedule
  preferred_areas         JSONB,                                    -- Array of zone IDs
  work_schedule           JSONB,                                    -- Weekly schedule JSON
  
  -- Bank & Payout
  bank_account_number     TEXT,                                     -- Encrypted
  bank_routing_number     TEXT,                                     -- Encrypted
  bank_verified           BOOLEAN DEFAULT FALSE,
  payout_schedule         VARCHAR(20) DEFAULT 'weekly',            -- daily, weekly, monthly
  pending_payout          DECIMAL(12,2) DEFAULT 0,
  
  -- Background Check
  background_check_status VARCHAR(20) DEFAULT 'pending',
  background_check_date   DATE,
  background_check_ref    VARCHAR(100),
  
  -- Onboarding
  onboarding_completed    BOOLEAN DEFAULT FALSE,
  onboarding_step         INTEGER DEFAULT 1,
  training_score          DECIMAL(5,2),
  training_completed_at   TIMESTAMP WITH TIME ZONE,
  
  created_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_drivers_status ON drivers(status);
CREATE INDEX idx_drivers_location ON drivers USING GIST(current_location);
CREATE INDEX idx_drivers_rating ON drivers(rating_overall DESC);

-- ============================================================
-- VEHICLES TABLE
-- ============================================================

CREATE TABLE vehicles (
  id                    UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  driver_id             UUID REFERENCES drivers(id) ON DELETE CASCADE,
  
  -- Identity
  plate_number          VARCHAR(20) NOT NULL,
  vin                   VARCHAR(17) UNIQUE,
  make                  VARCHAR(50) NOT NULL,
  model                 VARCHAR(50) NOT NULL,
  year                  SMALLINT NOT NULL,
  color                 VARCHAR(30) NOT NULL,
  
  -- Type & Capacity
  vehicle_type          vehicle_type NOT NULL,
  passenger_capacity    SMALLINT DEFAULT 4,
  cargo_capacity_kg     DECIMAL(8,2),
  cargo_capacity_m3     DECIMAL(6,2),
  has_refrigeration     BOOLEAN DEFAULT FALSE,
  refrigeration_range   JSONB,                                      -- { min_c: -18, max_c: 8 }
  
  -- Condition
  is_active             BOOLEAN DEFAULT TRUE,
  fuel_type             VARCHAR(20) DEFAULT 'petrol',              -- petrol, diesel, electric, hybrid
  fuel_efficiency_km_l  DECIMAL(5,2),
  odometer_km           DECIMAL(10,2),
  last_service_date     DATE,
  next_service_km       DECIMAL(10,2),
  
  -- Insurance & Registration
  insurance_policy      VARCHAR(100),
  insurance_expiry      DATE,
  registration_expiry   DATE,
  
  -- IoT
  iot_device_id         VARCHAR(100),                              -- Tracking device ID
  has_dashcam           BOOLEAN DEFAULT FALSE,
  dashcam_device_id     VARCHAR(100),
  
  -- AI Assessment
  ai_condition_score    DECIMAL(4,2),                             -- 0-100 from AI inspection
  ai_assessment_date    TIMESTAMP WITH TIME ZONE,
  
  photos                JSONB,                                     -- Array of photo URLs
  
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_vehicles_driver ON vehicles(driver_id);
CREATE INDEX idx_vehicles_type ON vehicles(vehicle_type);
CREATE INDEX idx_vehicles_plate ON vehicles(plate_number);

-- ============================================================
-- PRICING ZONES
-- ============================================================

CREATE TABLE pricing_zones (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name              VARCHAR(100) NOT NULL,
  city              VARCHAR(100) NOT NULL,
  country_code      CHAR(2) NOT NULL,
  boundary          GEOGRAPHY(POLYGON, 4326) NOT NULL,
  timezone          VARCHAR(50) NOT NULL,
  currency_code     CHAR(3) DEFAULT 'USD',
  
  -- Base Fares (Taxi)
  taxi_base_fare        DECIMAL(8,2) DEFAULT 2.50,
  taxi_per_km           DECIMAL(8,4) DEFAULT 1.20,
  taxi_per_minute       DECIMAL(8,4) DEFAULT 0.25,
  taxi_minimum_fare     DECIMAL(8,2) DEFAULT 5.00,
  taxi_cancellation_fee DECIMAL(8,2) DEFAULT 3.00,
  
  -- Base Fares (Freight)
  freight_base_fare     DECIMAL(8,2) DEFAULT 5.00,
  freight_per_km        DECIMAL(8,4) DEFAULT 2.00,
  freight_per_kg        DECIMAL(8,4) DEFAULT 0.05,
  freight_per_m3        DECIMAL(8,4) DEFAULT 2.00,
  
  -- Cold Chain Premium
  cold_chain_multiplier DECIMAL(4,2) DEFAULT 1.35,
  
  -- Peak Hours Config
  peak_hours            JSONB,                                    -- Schedule of peak windows
  
  is_active             BOOLEAN DEFAULT TRUE,
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_zones_boundary ON pricing_zones USING GIST(boundary);
CREATE INDEX idx_zones_city ON pricing_zones(city, country_code);

-- ============================================================
-- SURGE PRICING (AI-managed)
-- ============================================================

CREATE TABLE surge_multipliers (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  zone_id         UUID REFERENCES pricing_zones(id),
  service_type    service_type NOT NULL,
  multiplier      DECIMAL(4,2) NOT NULL DEFAULT 1.00,
  reason          VARCHAR(100),                                   -- 'high_demand', 'weather', 'event'
  ai_confidence   DECIMAL(4,3),                                  -- AI's confidence 0-1
  active_from     TIMESTAMP WITH TIME ZONE NOT NULL,
  active_until    TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_surge_zone_time ON surge_multipliers(zone_id, active_from, active_until);

-- ============================================================
-- TRIPS (TAXI/PASSENGER)
-- ============================================================

CREATE TABLE trips (
  id                    UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  trip_number           VARCHAR(30) UNIQUE NOT NULL,              -- TRP-20240001
  
  -- Parties
  customer_id           UUID REFERENCES users(id) NOT NULL,
  driver_id             UUID REFERENCES drivers(id),
  vehicle_id            UUID REFERENCES vehicles(id),
  
  -- Service
  service_type          service_type NOT NULL DEFAULT 'taxi',
  vehicle_type_requested vehicle_type,
  
  -- Route
  pickup_lat            DECIMAL(10,7) NOT NULL,
  pickup_lng            DECIMAL(10,7) NOT NULL,
  pickup_address        TEXT NOT NULL,
  pickup_place_id       VARCHAR(200),
  dropoff_lat           DECIMAL(10,7) NOT NULL,
  dropoff_lng           DECIMAL(10,7) NOT NULL,
  dropoff_address       TEXT NOT NULL,
  dropoff_place_id      VARCHAR(200),
  stops                 JSONB,                                    -- Array of intermediate stops
  
  -- AI Route Planning
  ai_route_polyline     TEXT,                                    -- Encoded polyline
  ai_route_distance_km  DECIMAL(8,3),
  ai_route_duration_min DECIMAL(8,2),
  ai_alternative_routes JSONB,
  
  -- Actual Route
  actual_route_polyline TEXT,
  actual_distance_km    DECIMAL(8,3),
  actual_duration_min   DECIMAL(8,2),
  
  -- Timing
  requested_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  scheduled_for         TIMESTAMP WITH TIME ZONE,               -- NULL = immediate
  driver_assigned_at    TIMESTAMP WITH TIME ZONE,
  driver_arrived_at     TIMESTAMP WITH TIME ZONE,
  trip_started_at       TIMESTAMP WITH TIME ZONE,
  trip_completed_at     TIMESTAMP WITH TIME ZONE,
  trip_cancelled_at     TIMESTAMP WITH TIME ZONE,
  
  -- AI ETA
  initial_eta_pickup_min  DECIMAL(6,2),
  initial_eta_dropoff_min DECIMAL(6,2),
  updated_eta_dropoff_min DECIMAL(6,2),
  eta_accuracy_seconds    INTEGER,                               -- Post-trip: how accurate was AI?
  
  -- Status
  status                trip_status DEFAULT 'requested',
  cancellation_reason   TEXT,
  cancelled_by          VARCHAR(10),                            -- 'customer', 'driver', 'system'
  
  -- Pricing
  zone_id               UUID REFERENCES pricing_zones(id),
  base_fare             DECIMAL(10,2),
  distance_fare         DECIMAL(10,2),
  time_fare             DECIMAL(10,2),
  surge_multiplier      DECIMAL(4,2) DEFAULT 1.00,
  surge_zone_id         UUID REFERENCES surge_multipliers(id),
  tolls                 DECIMAL(8,2) DEFAULT 0,
  tips                  DECIMAL(8,2) DEFAULT 0,
  promo_discount        DECIMAL(8,2) DEFAULT 0,
  promo_code_id         UUID,
  platform_fee          DECIMAL(8,2),
  driver_earnings       DECIMAL(10,2),
  total_fare            DECIMAL(10,2),
  estimated_fare        DECIMAL(10,2),
  currency              CHAR(3) DEFAULT 'USD',
  
  -- Payment
  payment_method        payment_method,
  payment_status        payment_status DEFAULT 'pending',
  payment_id            UUID,
  
  -- Ratings
  customer_rating       SMALLINT CHECK (customer_rating BETWEEN 1 AND 5),
  customer_review       TEXT,
  driver_rating         SMALLINT CHECK (driver_rating BETWEEN 1 AND 5),
  rated_at              TIMESTAMP WITH TIME ZONE,
  
  -- AI Decisions
  dispatch_ai_score     DECIMAL(6,4),                           -- AI score for this match
  dispatch_alternatives INTEGER,                                -- How many drivers were considered
  ai_safety_score       DECIMAL(4,3),                          -- Trip safety score
  
  -- Safety
  sos_triggered         BOOLEAN DEFAULT FALSE,
  sos_at                TIMESTAMP WITH TIME ZONE,
  route_deviation       BOOLEAN DEFAULT FALSE,
  
  -- Metadata
  platform              VARCHAR(20),                           -- ios, android, web
  app_version           VARCHAR(20),
  
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_trips_customer ON trips(customer_id);
CREATE INDEX idx_trips_driver ON trips(driver_id);
CREATE INDEX idx_trips_status ON trips(status);
CREATE INDEX idx_trips_requested ON trips(requested_at DESC);
CREATE INDEX idx_trips_number ON trips(trip_number);

-- ============================================================
-- DRIVER LOCATION HISTORY (TimescaleDB Hypertable)
-- ============================================================

CREATE TABLE driver_locations (
  time        TIMESTAMP WITH TIME ZONE NOT NULL,
  driver_id   UUID NOT NULL,
  location    GEOGRAPHY(POINT, 4326) NOT NULL,
  lat         DECIMAL(10,7) NOT NULL,
  lng         DECIMAL(10,7) NOT NULL,
  speed_kmh   DECIMAL(5,2),
  heading     SMALLINT,
  accuracy_m  SMALLINT,
  trip_id     UUID,
  battery_pct SMALLINT
);

SELECT create_hypertable('driver_locations', 'time');
CREATE INDEX idx_driver_locations_driver_time ON driver_locations(driver_id, time DESC);
CREATE INDEX idx_driver_locations_geo ON driver_locations USING GIST(location);

-- Automatic compression after 7 days
SELECT add_compression_policy('driver_locations', INTERVAL '7 days');
-- Retain for 6 months
SELECT add_retention_policy('driver_locations', INTERVAL '6 months');

-- ============================================================
-- DELIVERIES (FREIGHT)
-- ============================================================

CREATE TABLE deliveries (
  id                      UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  delivery_number         VARCHAR(30) UNIQUE NOT NULL,            -- DEL-20240001
  
  -- Parties
  customer_id             UUID REFERENCES users(id) NOT NULL,
  driver_id               UUID REFERENCES drivers(id),
  vehicle_id              UUID REFERENCES vehicles(id),
  
  -- Cargo
  cargo_description       TEXT NOT NULL,
  cargo_category          VARCHAR(50),                          -- electronics, food, furniture...
  cargo_weight_kg         DECIMAL(8,2) NOT NULL,
  cargo_length_cm         DECIMAL(7,2),
  cargo_width_cm          DECIMAL(7,2),
  cargo_height_cm         DECIMAL(7,2),
  cargo_volume_m3         DECIMAL(6,3),
  cargo_value             DECIMAL(12,2),                        -- Declared value
  is_fragile              BOOLEAN DEFAULT FALSE,
  is_hazardous            BOOLEAN DEFAULT FALSE,
  hazmat_class            VARCHAR(20),
  requires_refrigeration  BOOLEAN DEFAULT FALSE,
  temp_min_celsius        DECIMAL(4,1),
  temp_max_celsius        DECIMAL(4,1),
  current_temp_celsius    DECIMAL(4,1),                         -- Live from IoT
  temp_alerts_count       INTEGER DEFAULT 0,
  
  -- Cargo Insurance
  insurance_requested     BOOLEAN DEFAULT FALSE,
  insurance_premium       DECIMAL(8,2),
  insurance_policy_ref    VARCHAR(100),
  
  -- Pickup
  pickup_contact_name     VARCHAR(100),
  pickup_contact_phone    VARCHAR(20),
  pickup_lat              DECIMAL(10,7) NOT NULL,
  pickup_lng              DECIMAL(10,7) NOT NULL,
  pickup_address          TEXT NOT NULL,
  pickup_notes            TEXT,
  pickup_window_start     TIMESTAMP WITH TIME ZONE,
  pickup_window_end       TIMESTAMP WITH TIME ZONE,
  pickup_otp              CHAR(6),                             -- One-time PIN for pickup verification
  pickup_signature_url    TEXT,
  pickup_photo_url        TEXT,
  picked_up_at            TIMESTAMP WITH TIME ZONE,
  
  -- Dropoff
  dropoff_contact_name    VARCHAR(100),
  dropoff_contact_phone   VARCHAR(20),
  dropoff_lat             DECIMAL(10,7) NOT NULL,
  dropoff_lng             DECIMAL(10,7) NOT NULL,
  dropoff_address         TEXT NOT NULL,
  dropoff_notes           TEXT,
  dropoff_window_start    TIMESTAMP WITH TIME ZONE,
  dropoff_window_end      TIMESTAMP WITH TIME ZONE,
  dropoff_otp             CHAR(6),
  dropoff_signature_url   TEXT,
  dropoff_photo_url       TEXT,
  delivered_at            TIMESTAMP WITH TIME ZONE,
  
  -- Tracking
  current_lat             DECIMAL(10,7),
  current_lng             DECIMAL(10,7),
  tracking_url            TEXT UNIQUE,                         -- Public tracking link
  
  -- Route
  ai_route_distance_km    DECIMAL(8,3),
  ai_route_duration_min   DECIMAL(8,2),
  actual_distance_km      DECIMAL(8,3),
  
  -- Status
  status                  delivery_status DEFAULT 'pending',
  failed_reason           TEXT,
  failed_attempt_count    SMALLINT DEFAULT 0,
  
  -- Timing
  requested_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  scheduled_pickup_at     TIMESTAMP WITH TIME ZONE,
  estimated_delivery_at   TIMESTAMP WITH TIME ZONE,
  
  -- Pricing
  zone_id                 UUID REFERENCES pricing_zones(id),
  base_fare               DECIMAL(10,2),
  distance_fare           DECIMAL(10,2),
  weight_fare             DECIMAL(10,2),
  volume_fare             DECIMAL(10,2),
  cold_chain_surcharge    DECIMAL(8,2) DEFAULT 0,
  express_surcharge       DECIMAL(8,2) DEFAULT 0,
  insurance_fee           DECIMAL(8,2) DEFAULT 0,
  platform_fee            DECIMAL(8,2),
  driver_earnings         DECIMAL(10,2),
  total_fare              DECIMAL(10,2),
  currency                CHAR(3) DEFAULT 'USD',
  
  -- Payment
  payment_method          payment_method,
  payment_status          payment_status DEFAULT 'pending',
  
  -- Rating
  customer_rating         SMALLINT CHECK (customer_rating BETWEEN 1 AND 5),
  customer_review         TEXT,
  
  -- Metadata
  platform                VARCHAR(20),
  created_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_deliveries_customer ON deliveries(customer_id);
CREATE INDEX idx_deliveries_driver ON deliveries(driver_id);
CREATE INDEX idx_deliveries_status ON deliveries(status);
CREATE INDEX idx_deliveries_tracking ON deliveries(tracking_url);

-- ============================================================
-- PAYMENTS
-- ============================================================

CREATE TABLE payments (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  payment_ref       VARCHAR(50) UNIQUE NOT NULL,
  trip_id           UUID REFERENCES trips(id),
  delivery_id       UUID REFERENCES deliveries(id),
  customer_id       UUID REFERENCES users(id) NOT NULL,
  
  amount            DECIMAL(12,2) NOT NULL,
  currency          CHAR(3) DEFAULT 'USD',
  method            payment_method NOT NULL,
  status            payment_status DEFAULT 'pending',
  
  -- Gateway
  gateway           VARCHAR(30) NOT NULL,                      -- stripe, paypal, mpesa, etc.
  gateway_ref       VARCHAR(200) UNIQUE,
  gateway_response  JSONB,
  
  -- Card details (tokenized)
  card_last4        CHAR(4),
  card_brand        VARCHAR(20),
  card_exp_month    SMALLINT,
  card_exp_year     SMALLINT,
  
  -- Metadata
  ip_address        INET,
  device_fingerprint TEXT,
  
  -- Fraud
  fraud_score       DECIMAL(4,3),
  fraud_flags       TEXT[],
  
  authorized_at     TIMESTAMP WITH TIME ZONE,
  captured_at       TIMESTAMP WITH TIME ZONE,
  failed_at         TIMESTAMP WITH TIME ZONE,
  refunded_at       TIMESTAMP WITH TIME ZONE,
  refund_amount     DECIMAL(12,2),
  refund_reason     TEXT,
  
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_payments_trip ON payments(trip_id);
CREATE INDEX idx_payments_delivery ON payments(delivery_id);
CREATE INDEX idx_payments_customer ON payments(customer_id);
CREATE INDEX idx_payments_gateway_ref ON payments(gateway_ref);

-- ============================================================
-- AI DECISIONS LOG
-- ============================================================

CREATE TABLE ai_decisions (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  decision_type   VARCHAR(50) NOT NULL,                        -- 'dispatch', 'pricing', 'eta', 'routing'
  module          VARCHAR(50) NOT NULL,                        -- AI module name
  
  -- Context
  trip_id         UUID,
  delivery_id     UUID,
  driver_id       UUID,
  zone_id         UUID,
  
  -- Input/Output (for model monitoring)
  input_features  JSONB NOT NULL,
  decision        JSONB NOT NULL,
  confidence      DECIMAL(6,5),
  model_version   VARCHAR(20),
  
  -- Evaluation
  was_correct     BOOLEAN,
  actual_outcome  JSONB,
  feedback_at     TIMESTAMP WITH TIME ZONE,
  
  processing_ms   SMALLINT,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

SELECT create_hypertable('ai_decisions', 'created_at');
CREATE INDEX idx_ai_decisions_type ON ai_decisions(decision_type, created_at DESC);

-- ============================================================
-- SAFETY INCIDENTS
-- ============================================================

CREATE TABLE safety_incidents (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  incident_ref    VARCHAR(30) UNIQUE NOT NULL,
  trip_id         UUID REFERENCES trips(id),
  delivery_id     UUID REFERENCES deliveries(id),
  driver_id       UUID REFERENCES drivers(id),
  customer_id     UUID REFERENCES users(id),
  
  type            VARCHAR(50) NOT NULL,                        -- 'sos', 'accident', 'route_deviation', 'harsh_braking'
  severity        incident_severity NOT NULL,
  description     TEXT,
  
  -- Location when incident occurred
  incident_lat    DECIMAL(10,7),
  incident_lng    DECIMAL(10,7),
  incident_address TEXT,
  
  -- AI Detection
  ai_detected     BOOLEAN DEFAULT FALSE,
  ai_confidence   DECIMAL(4,3),
  
  -- Resolution
  status          VARCHAR(20) DEFAULT 'open',                 -- open, investigating, resolved
  resolved_by     UUID REFERENCES users(id),
  resolution_note TEXT,
  resolved_at     TIMESTAMP WITH TIME ZONE,
  
  occurred_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

CREATE TABLE notifications (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID REFERENCES users(id) NOT NULL,
  channel     notification_channel NOT NULL,
  
  title       VARCHAR(200),
  body        TEXT NOT NULL,
  data        JSONB,
  
  -- Delivery
  sent_at     TIMESTAMP WITH TIME ZONE,
  delivered_at TIMESTAMP WITH TIME ZONE,
  read_at     TIMESTAMP WITH TIME ZONE,
  failed_at   TIMESTAMP WITH TIME ZONE,
  failure_reason TEXT,
  
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

SELECT create_hypertable('notifications', 'created_at');
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);

-- ============================================================
-- PROMOTIONS
-- ============================================================

CREATE TABLE promotions (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code                VARCHAR(30) UNIQUE NOT NULL,
  description         TEXT,
  
  type                VARCHAR(20) NOT NULL,                   -- 'percentage', 'fixed', 'free_ride'
  value               DECIMAL(8,2) NOT NULL,
  max_discount        DECIMAL(8,2),
  min_trip_value      DECIMAL(8,2) DEFAULT 0,
  
  service_types       service_type[],
  vehicle_types       vehicle_type[],
  zone_ids            UUID[],
  
  -- Usage limits
  usage_limit_global  INTEGER,
  usage_limit_per_user INTEGER DEFAULT 1,
  times_used          INTEGER DEFAULT 0,
  
  -- Eligibility
  new_users_only      BOOLEAN DEFAULT FALSE,
  requires_tier       VARCHAR(20),
  
  valid_from          TIMESTAMP WITH TIME ZONE NOT NULL,
  valid_until         TIMESTAMP WITH TIME ZONE NOT NULL,
  is_active           BOOLEAN DEFAULT TRUE,
  
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- DRIVER DOCUMENTS
-- ============================================================

CREATE TABLE driver_documents (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  driver_id       UUID REFERENCES drivers(id) NOT NULL,
  
  type            VARCHAR(50) NOT NULL,                       -- 'license', 'insurance', 'registration', 'photo_id'
  document_url    TEXT NOT NULL,
  
  -- AI Verification
  ai_verified     BOOLEAN DEFAULT FALSE,
  ai_confidence   DECIMAL(4,3),
  ai_extracted    JSONB,                                      -- OCR extracted fields
  
  -- Manual Review
  status          document_status DEFAULT 'pending',
  verified_by     UUID REFERENCES users(id),
  rejection_reason TEXT,
  
  issue_date      DATE,
  expiry_date     DATE,
  
  uploaded_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  verified_at     TIMESTAMP WITH TIME ZONE,
  
  CONSTRAINT unique_driver_doc_type UNIQUE(driver_id, type)
);

-- ============================================================
-- FLEET MAINTENANCE
-- ============================================================

CREATE TABLE vehicle_maintenance (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  vehicle_id      UUID REFERENCES vehicles(id) NOT NULL,
  
  type            VARCHAR(50) NOT NULL,                      -- 'oil_change', 'tire_rotation', 'brake_check'
  description     TEXT,
  
  -- AI Prediction
  ai_recommended  BOOLEAN DEFAULT FALSE,
  ai_urgency      VARCHAR(10),                               -- 'routine', 'soon', 'urgent'
  
  scheduled_for   DATE,
  completed_at    TIMESTAMP WITH TIME ZONE,
  
  service_center  VARCHAR(200),
  cost            DECIMAL(8,2),
  
  odometer_at_service DECIMAL(10,2),
  next_service_km     DECIMAL(10,2),
  
  notes           TEXT,
  receipt_url     TEXT,
  
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOG
-- ============================================================

CREATE TABLE audit_logs (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  actor_id    UUID REFERENCES users(id),
  actor_role  user_role,
  action      VARCHAR(100) NOT NULL,
  resource    VARCHAR(50) NOT NULL,
  resource_id UUID,
  old_values  JSONB,
  new_values  JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

SELECT create_hypertable('audit_logs', 'created_at');

-- ============================================================
-- VIEWS
-- ============================================================

-- Active drivers with their current vehicle
CREATE MATERIALIZED VIEW active_drivers_view AS
SELECT
  d.id, d.user_id, d.driver_number, d.status,
  d.current_location, d.rating_overall, d.service_types,
  u.first_name, u.last_name, u.phone, u.avatar_url,
  v.id as vehicle_id, v.vehicle_type, v.make, v.model,
  v.color, v.plate_number, v.passenger_capacity,
  v.cargo_capacity_kg, v.has_refrigeration
FROM drivers d
JOIN users u ON d.user_id = u.id
JOIN vehicles v ON v.driver_id = d.id AND v.is_active = TRUE
WHERE d.is_online = TRUE AND d.status = 'available';

CREATE UNIQUE INDEX ON active_drivers_view(id);
CREATE INDEX ON active_drivers_view USING GIST(current_location);

-- Trip analytics summary
CREATE VIEW trip_summary_today AS
SELECT
  COUNT(*) FILTER (WHERE status = 'completed') as completed,
  COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
  COUNT(*) FILTER (WHERE status IN ('requested', 'searching', 'accepted', 'driver_en_route', 'in_progress')) as active,
  SUM(total_fare) FILTER (WHERE status = 'completed') as revenue,
  AVG(actual_distance_km) FILTER (WHERE status = 'completed') as avg_distance,
  AVG(customer_rating) FILTER (WHERE customer_rating IS NOT NULL) as avg_rating,
  AVG(eta_accuracy_seconds) FILTER (WHERE eta_accuracy_seconds IS NOT NULL) as avg_eta_accuracy
FROM trips
WHERE DATE(created_at) = CURRENT_DATE;

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER drivers_updated_at BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER vehicles_updated_at BEFORE UPDATE ON vehicles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trips_updated_at BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER deliveries_updated_at BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Update driver rating after trip rating
CREATE OR REPLACE FUNCTION update_driver_rating()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.driver_rating IS NOT NULL AND OLD.driver_rating IS NULL THEN
    UPDATE drivers SET
      rating_overall = (
        SELECT ROUND(AVG(customer_rating)::NUMERIC, 2)
        FROM trips WHERE driver_id = NEW.driver_id AND customer_rating IS NOT NULL
      ),
      rating_count = (
        SELECT COUNT(*) FROM trips WHERE driver_id = NEW.driver_id AND customer_rating IS NOT NULL
      ),
      updated_at = NOW()
    WHERE id = NEW.driver_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trip_rating_update
AFTER UPDATE OF customer_rating ON trips
FOR EACH ROW EXECUTE FUNCTION update_driver_rating();

-- ============================================================
-- SEED: Default Admin User
-- ============================================================

INSERT INTO users (id, role, email, phone, first_name, last_name, password_hash, salt, is_verified, phone_verified, email_verified)
VALUES (
  uuid_generate_v4(),
  'admin',
  'admin@nexuslogistics.ai',
  '+10000000000',
  'System',
  'Administrator',
  'PLACEHOLDER_BCRYPT_HASH',
  'PLACEHOLDER_SALT',
  TRUE, TRUE, TRUE
);
