-- Migration 020: Gmail scan tracking
-- Adds last_scan_at to email_integrations so the frontend can show
-- "Last scanned X minutes ago" without hitting the Gmail API.
ALTER TABLE email_integrations
  ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ;

-- Explicit single-column index on hotel_id for fast per-hotel lookups.
-- Note: the unique constraint on (hotel_id, provider) already creates a
-- composite index that covers hotel_id, but this explicit index is
-- used by the 30-min background scan job which queries only on hotel_id.
CREATE INDEX IF NOT EXISTS idx_email_integrations_hotel
  ON email_integrations(hotel_id);
