-- Migration 008: Add sender_display_name to messages table
-- Captures the staff display name at send time for historical accuracy.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_display_name VARCHAR(255);
