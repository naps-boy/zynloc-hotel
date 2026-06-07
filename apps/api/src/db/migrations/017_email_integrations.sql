-- Migration 017: email integrations (Gmail future use)
CREATE TABLE IF NOT EXISTS email_integrations (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id      UUID          NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  provider      VARCHAR(50)   NOT NULL DEFAULT 'gmail',
  access_token  TEXT,
  refresh_token TEXT,
  token_expiry  TIMESTAMPTZ,
  email_address VARCHAR(255),
  is_active     BOOLEAN       DEFAULT false,
  created_at    TIMESTAMPTZ   DEFAULT now(),
  updated_at    TIMESTAMPTZ   DEFAULT now()
);
