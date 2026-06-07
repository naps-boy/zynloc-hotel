-- Migration 015: booking source tracking
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_source  VARCHAR(50)   DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_reference VARCHAR(255),
  ADD COLUMN IF NOT EXISTS imported_at     TIMESTAMPTZ;
