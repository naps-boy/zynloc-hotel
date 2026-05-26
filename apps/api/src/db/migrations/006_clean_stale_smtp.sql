-- Migration 006: Remove stale Brevo SMTP configs created before the platform config
-- was properly set up (2026-05-24 17:44:29 UTC).
-- Config 6d64389a-dfa9-4388-9600-edc7f0b1ad1f and any other pre-platform configs
-- contain a revoked API key that returns "Key not found" from Brevo.
-- After this migration the oldest is_default Brevo config is the valid platform one
-- used as the shared fallback for hotels without their own SMTP config.

DELETE FROM smtp_configs
 WHERE provider = 'brevo'
   AND created_at < '2026-05-24 17:44:00+00';
