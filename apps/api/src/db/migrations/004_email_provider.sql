-- Migration 004: Multi-provider email support
-- Adds a 'provider' column to smtp_configs so hotels can choose between:
--   'brevo'  — Brevo HTTP API (port 443, works on Render free tier)
--   'gmail'  — nodemailer service:gmail shorthand (port 465 SSL)
--   'custom' — raw SMTP with full host/port/user config
--
-- Also makes smtp_host / smtp_port / smtp_user nullable because
-- they are not used by the Brevo and Gmail providers.

ALTER TABLE smtp_configs
  ADD COLUMN IF NOT EXISTS provider VARCHAR(20) NOT NULL DEFAULT 'custom';

-- Make SMTP-only fields nullable (not needed for brevo / gmail providers)
ALTER TABLE smtp_configs ALTER COLUMN smtp_host  DROP NOT NULL;
ALTER TABLE smtp_configs ALTER COLUMN smtp_port  DROP NOT NULL;
ALTER TABLE smtp_configs ALTER COLUMN smtp_user  DROP NOT NULL;
