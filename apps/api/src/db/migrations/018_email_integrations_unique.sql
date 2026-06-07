-- Migration 018: unique constraint on email_integrations(hotel_id, provider)
-- Required for ON CONFLICT upsert in Gmail OAuth callback.
-- DROP first so this migration is safely re-runnable (idempotent).
ALTER TABLE email_integrations
  DROP CONSTRAINT IF EXISTS email_integrations_hotel_provider_unique;

ALTER TABLE email_integrations
  ADD CONSTRAINT email_integrations_hotel_provider_unique
  UNIQUE (hotel_id, provider);
