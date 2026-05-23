-- Migration 003: Per-hotel SMTP email configuration
-- Each hotel can store multiple SMTP configs; one is marked is_default.
-- The email service picks the default config when sending transactional emails.

CREATE TABLE IF NOT EXISTS smtp_configs (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    UUID         NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  label       VARCHAR(100) NOT NULL DEFAULT 'Default',
  sender_name VARCHAR(255) NOT NULL,
  email       VARCHAR(255) NOT NULL,
  smtp_host   VARCHAR(255) NOT NULL DEFAULT 'smtp.gmail.com',
  smtp_port   INTEGER      NOT NULL DEFAULT 587,
  smtp_user   VARCHAR(255) NOT NULL,
  smtp_pass   TEXT         NOT NULL,
  is_default  BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_smtp_configs_hotel_id ON smtp_configs(hotel_id);
CREATE INDEX IF NOT EXISTS idx_smtp_configs_default  ON smtp_configs(hotel_id, is_default);
