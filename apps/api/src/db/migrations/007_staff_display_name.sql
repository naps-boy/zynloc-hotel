-- Migration 007: Add display_name to staff table
-- Used as the chat display name shown in message bubbles instead of real name.
-- Falls back to name when NULL.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
