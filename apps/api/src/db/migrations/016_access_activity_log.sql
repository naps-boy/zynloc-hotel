-- Migration 016: access activity log
CREATE TABLE IF NOT EXISTS access_activity_log (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         UUID          NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  booking_id       UUID          REFERENCES bookings(id) ON DELETE SET NULL,
  guest_id         UUID          REFERENCES guests(id)   ON DELETE SET NULL,
  actor_name       VARCHAR(255),
  actor_type       VARCHAR(50)   DEFAULT 'guest',
  resource_type    VARCHAR(50)   NOT NULL,
  resource_id      UUID,
  resource_name    VARCHAR(255),
  action           VARCHAR(50)   NOT NULL,
  result           VARCHAR(50)   NOT NULL,
  accessed_at      TIMESTAMPTZ   DEFAULT now(),
  exited_at        TIMESTAMPTZ,
  duration_minutes INTEGER,
  metadata         JSONB         DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_access_activity_hotel    ON access_activity_log(hotel_id);
CREATE INDEX IF NOT EXISTS idx_access_activity_booking  ON access_activity_log(booking_id);
CREATE INDEX IF NOT EXISTS idx_access_activity_accessed ON access_activity_log(accessed_at DESC);
