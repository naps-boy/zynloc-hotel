-- Floor plan storage (base64 image, one per hotel)
CREATE TABLE IF NOT EXISTS floor_plans (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id   UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  image_data TEXT NOT NULL,
  width      INTEGER DEFAULT 800,
  height     INTEGER DEFAULT 600,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(hotel_id)
);

-- Add percentage-based coords and base64 photo to waypoints
ALTER TABLE navigation_waypoints ADD COLUMN IF NOT EXISTS x_percent FLOAT DEFAULT 50;
ALTER TABLE navigation_waypoints ADD COLUMN IF NOT EXISTS y_percent FLOAT DEFAULT 50;
ALTER TABLE navigation_waypoints ADD COLUMN IF NOT EXISTS photo_data TEXT DEFAULT '';
