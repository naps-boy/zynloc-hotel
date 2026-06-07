-- Migration 018: unique constraint on email_integrations(hotel_id, provider)
-- Required for ON CONFLICT upsert in Gmail OAuth callback
ALTER TABLE email_integrations
  ADD CONSTRAINT IF NOT EXISTS email_integrations_hotel_provider_unique
  UNIQUE (hotel_id, provider);
