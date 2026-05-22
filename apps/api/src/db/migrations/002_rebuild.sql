-- 002_rebuild.sql  Full feature rebuild additions
-- Runs inside a transaction on real PostgreSQL.
-- pg-mem will skip statements it cannot parse (runMigrations handles per-statement gracefully).

-- ─────────────────────────────────────────────────────────────────────────────
-- Packages
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE packages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    UUID        NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  price       NUMERIC     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS packages_hotel_name_idx ON packages(hotel_id, name);

CREATE TABLE package_facilities (
  package_id  UUID NOT NULL REFERENCES packages(id)    ON DELETE CASCADE,
  facility_id UUID NOT NULL REFERENCES facilities(id)  ON DELETE CASCADE,
  PRIMARY KEY (package_id, facility_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Static facility QR codes  (one per facility, printed and placed on-site)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE facility_qr_codes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    UUID        NOT NULL REFERENCES hotels(id)      ON DELETE CASCADE,
  facility_id UUID        NOT NULL REFERENCES facilities(id)  ON DELETE CASCADE,
  token       TEXT        NOT NULL UNIQUE,
  qr_data_url TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS facility_qr_hotel_facility_idx ON facility_qr_codes(hotel_id, facility_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Static checkout QR code  (one per hotel, placed at reception / gate)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE checkout_qr_codes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    UUID        NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  token       TEXT        NOT NULL UNIQUE,
  qr_data_url TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS checkout_qr_hotel_idx ON checkout_qr_codes(hotel_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indoor navigation
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE navigation_waypoints (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id       UUID        NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  photo_url      TEXT        NOT NULL DEFAULT '',
  x              NUMERIC     NOT NULL DEFAULT 0,
  y              NUMERIC     NOT NULL DEFAULT 0,
  floor          INTEGER     NOT NULL DEFAULT 1,
  waypoint_type  TEXT        NOT NULL DEFAULT 'corridor',
  ref_id         UUID        DEFAULT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE navigation_connections (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         UUID        NOT NULL REFERENCES hotels(id)               ON DELETE CASCADE,
  from_waypoint_id UUID        NOT NULL REFERENCES navigation_waypoints(id) ON DELETE CASCADE,
  to_waypoint_id   UUID        NOT NULL REFERENCES navigation_waypoints(id) ON DELETE CASCADE,
  distance         NUMERIC     NOT NULL DEFAULT 1,
  direction_hint   TEXT        NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS nav_conn_unique_idx ON navigation_connections(from_waypoint_id, to_waypoint_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Service requests (separate from notifications)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE service_requests (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id          UUID        NOT NULL REFERENCES hotels(id)      ON DELETE CASCADE,
  booking_id        UUID        NOT NULL REFERENCES bookings(id)    ON DELETE CASCADE,
  guest_id          UUID        NOT NULL REFERENCES guests(id)      ON DELETE CASCADE,
  type              TEXT        NOT NULL,
  note              TEXT        NOT NULL DEFAULT '',
  status            TEXT        NOT NULL DEFAULT 'open',
  assigned_staff_id UUID        REFERENCES staff(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Guest enhancements
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE guests ADD COLUMN selfie_url       TEXT    NOT NULL DEFAULT '';
ALTER TABLE guests ADD COLUMN face_descriptor  JSONB   DEFAULT NULL;
ALTER TABLE guests ADD COLUMN profile_complete BOOLEAN NOT NULL DEFAULT FALSE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Booking enhancements
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE bookings ADD COLUMN special_notes              TEXT        NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN package_id                 UUID        REFERENCES packages(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN checkin_token              TEXT        UNIQUE;
ALTER TABLE bookings ADD COLUMN checkin_token_expires_at   TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN profile_status             TEXT        NOT NULL DEFAULT 'pending';
ALTER TABLE bookings ADD COLUMN guest_phone                TEXT        NOT NULL DEFAULT '';

-- ─────────────────────────────────────────────────────────────────────────────
-- Room enhancements
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE rooms ADD COLUMN description TEXT  NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN photos      JSONB NOT NULL DEFAULT '[]';

-- ─────────────────────────────────────────────────────────────────────────────
-- Facility enhancements
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE facilities ADD COLUMN icon   TEXT  NOT NULL DEFAULT 'dumbbell';
ALTER TABLE facilities ADD COLUMN photos JSONB NOT NULL DEFAULT '[]';

-- ─────────────────────────────────────────────────────────────────────────────
-- Hotel enhancements
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE hotels ADD COLUMN floor_plan_url       TEXT    NOT NULL DEFAULT '';
ALTER TABLE hotels ADD COLUMN floor_plan_markers   JSONB   NOT NULL DEFAULT '[]';
ALTER TABLE hotels ADD COLUMN onboarding_complete  BOOLEAN NOT NULL DEFAULT FALSE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Notification enhancements
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE notifications ADD COLUMN event_type   TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN guest_photo  TEXT NOT NULL DEFAULT '';

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS service_requests_hotel_idx     ON service_requests(hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS nav_waypoints_hotel_idx        ON navigation_waypoints(hotel_id);
CREATE INDEX IF NOT EXISTS bookings_checkin_token_idx     ON bookings(checkin_token);
CREATE INDEX IF NOT EXISTS facility_qr_token_idx          ON facility_qr_codes(token);
CREATE INDEX IF NOT EXISTS checkout_qr_token_idx          ON checkout_qr_codes(token);
