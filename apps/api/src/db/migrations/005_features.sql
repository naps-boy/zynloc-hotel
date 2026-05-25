-- 005_features.sql  Forgot-password tokens, reception QR columns, revoked flag
-- Each ALTER runs in isolation so pg-mem can skip unsupported statements gracefully.

-- ─── Password reset tokens ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   UUID        NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  token      TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Reception QR columns on hotels (rotating 30-min window) ─────────────────
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS reception_token TEXT DEFAULT NULL;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS reception_token_expires_at TIMESTAMPTZ DEFAULT NULL;

-- ─── Revoked flag on bookings ─────────────────────────────────────────────────
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS revoked BOOLEAN NOT NULL DEFAULT FALSE;
