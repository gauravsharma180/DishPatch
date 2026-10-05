-- DishPatch schema. Money is stored in paise (integer) to avoid float rounding.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('CUSTOMER', 'RESTAURANT', 'DRIVER', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM (
    'PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED',
    'REJECTED', 'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE dispatch_state AS ENUM ('PENDING', 'SEARCHING', 'ASSIGNED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE driver_status AS ENUM ('OFFLINE', 'ONLINE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restaurants (
  id                BIGSERIAL PRIMARY KEY,
  owner_id          BIGINT REFERENCES users(id),
  name              TEXT NOT NULL,
  cuisine           TEXT,
  lat               DOUBLE PRECISION NOT NULL,
  lng               DOUBLE PRECISION NOT NULL,
  is_open           BOOLEAN NOT NULL DEFAULT TRUE,
  avg_prep_minutes  INT NOT NULL DEFAULT 15,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id            BIGSERIAL PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  price_paise   INT NOT NULL CHECK (price_paise > 0),
  stock         INT NOT NULL DEFAULT 0 CHECK (stock >= 0),   -- DB-level guard against overselling
  is_available  BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_menu_restaurant ON menu_items(restaurant_id);

CREATE TABLE IF NOT EXISTS drivers (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT UNIQUE REFERENCES users(id),
  name           TEXT NOT NULL,
  vehicle        TEXT NOT NULL DEFAULT 'BIKE',
  status         driver_status NOT NULL DEFAULT 'OFFLINE',
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  active_orders  INT NOT NULL DEFAULT 0 CHECK (active_orders >= 0),
  max_orders     INT NOT NULL DEFAULT 2 CHECK (max_orders > 0),
  last_assigned_at TIMESTAMPTZ,
  last_seen_at   TIMESTAMPTZ,
  CONSTRAINT capacity_ck CHECK (active_orders <= max_orders)
);

CREATE TABLE IF NOT EXISTS orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      BIGINT NOT NULL REFERENCES users(id),
  restaurant_id    BIGINT NOT NULL REFERENCES restaurants(id),
  driver_id        BIGINT REFERENCES drivers(id),
  status           order_status NOT NULL DEFAULT 'PLACED',
  dispatch_state   dispatch_state NOT NULL DEFAULT 'PENDING',
  dispatch_attempts INT NOT NULL DEFAULT 0,
  total_paise      INT NOT NULL,
  delivery_lat     DOUBLE PRECISION NOT NULL,
  delivery_lng     DOUBLE PRECISION NOT NULL,
  delivery_address TEXT,
  idempotency_key  TEXT NOT NULL,
  version          INT NOT NULL DEFAULT 1,
  ready_by         TIMESTAMPTZ,
  assigned_at      TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Second line of defence for idempotency if the Redis key is lost.
  CONSTRAINT uq_customer_idem UNIQUE (customer_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_status ON orders(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_driver_active ON orders(driver_id) WHERE status IN ('ACCEPTED','PREPARING','READY','PICKED_UP');

CREATE TABLE IF NOT EXISTS order_items (
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id BIGINT NOT NULL REFERENCES menu_items(id),
  name         TEXT NOT NULL,
  qty          INT NOT NULL CHECK (qty > 0),
  price_paise  INT NOT NULL,
  PRIMARY KEY (order_id, menu_item_id)
);

-- Append-only audit trail of every lifecycle transition.
CREATE TABLE IF NOT EXISTS order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status order_status,
  to_status   order_status NOT NULL,
  actor_role  user_role,
  actor_id    BIGINT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id, id);

-- Every dispatch decision, so scoring can be audited and tuned offline.
CREATE TABLE IF NOT EXISTS dispatch_log (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  driver_id   BIGINT REFERENCES drivers(id),
  attempt     INT NOT NULL,
  radius_km   DOUBLE PRECISION,
  candidates  INT NOT NULL DEFAULT 0,
  score       DOUBLE PRECISION,
  distance_m  DOUBLE PRECISION,
  eta_sec     INT,
  outcome     TEXT NOT NULL,       -- ASSIGNED | NO_CANDIDATES | CLAIM_LOST | FAILED
  latency_ms  INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispatch_order ON dispatch_log(order_id);
