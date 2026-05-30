-- Drop old navigation tables (both old names and 011 names)
DROP TABLE IF EXISTS navigation_connections CASCADE;
DROP TABLE IF EXISTS navigation_waypoints CASCADE;
DROP TABLE IF EXISTS floor_plans CASCADE;
DROP TABLE IF EXISTS waypoint_connections CASCADE;
DROP TABLE IF EXISTS waypoints CASCADE;

-- Multi-floor floor plans (one per floor per hotel)
CREATE TABLE IF NOT EXISTS floor_plans (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     UUID         NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  floor_number INTEGER      NOT NULL DEFAULT 1,
  floor_name   VARCHAR(255) NOT NULL DEFAULT 'Ground Floor',
  image_data   TEXT         NOT NULL,
  width        INTEGER      NOT NULL DEFAULT 800,
  height       INTEGER      NOT NULL DEFAULT 600,
  created_at   TIMESTAMPTZ  DEFAULT now(),
  UNIQUE(hotel_id, floor_number)
);

-- Waypoints placed on a floor plan
CREATE TABLE IF NOT EXISTS nav_waypoints (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id       UUID         NOT NULL REFERENCES hotels(id)      ON DELETE CASCADE,
  floor_plan_id  UUID         NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL,
  x_percent      FLOAT        NOT NULL,
  y_percent      FLOAT        NOT NULL,
  photo_data     TEXT,
  waypoint_type  VARCHAR(50)  DEFAULT 'junction',
  room_id        UUID         REFERENCES rooms(id)      ON DELETE SET NULL,
  facility_id    UUID         REFERENCES facilities(id) ON DELETE SET NULL,
  is_entrance    BOOLEAN      DEFAULT false,
  created_at     TIMESTAMPTZ  DEFAULT now()
);

-- Paths connecting waypoints (control_points bends the path around walls)
CREATE TABLE IF NOT EXISTS nav_paths (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id          UUID        NOT NULL REFERENCES hotels(id)        ON DELETE CASCADE,
  from_waypoint_id  UUID        NOT NULL REFERENCES nav_waypoints(id) ON DELETE CASCADE,
  to_waypoint_id    UUID        NOT NULL REFERENCES nav_waypoints(id) ON DELETE CASCADE,
  control_points    JSONB       DEFAULT '[]',
  distance          FLOAT       DEFAULT 1.0,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nav_waypoints_hotel  ON nav_waypoints(hotel_id);
CREATE INDEX IF NOT EXISTS idx_nav_paths_hotel      ON nav_paths(hotel_id);
CREATE INDEX IF NOT EXISTS idx_floor_plans_hotel    ON floor_plans(hotel_id);
