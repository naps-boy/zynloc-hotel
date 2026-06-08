-- Migration 019: Seam access control integration tables

-- Access provider interface — vendor agnostic
CREATE TABLE IF NOT EXISTS access_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  provider_type VARCHAR(50) NOT NULL DEFAULT 'seam',
  provider_name VARCHAR(100) NOT NULL DEFAULT 'Seam',
  api_key_encrypted TEXT,
  workspace_id VARCHAR(255),
  is_active BOOLEAN DEFAULT false,
  config JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(hotel_id, provider_type)
);

-- Map rooms to physical lock devices
CREATE TABLE IF NOT EXISTS room_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  provider_type VARCHAR(50) NOT NULL DEFAULT 'seam',
  device_id VARCHAR(255) NOT NULL,
  device_name VARCHAR(255),
  device_type VARCHAR(100),
  is_online BOOLEAN DEFAULT false,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(hotel_id, room_id, provider_type)
);

-- Track issued access credentials
CREATE TABLE IF NOT EXISTS access_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  guest_id UUID REFERENCES guests(id) ON DELETE SET NULL,
  room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,
  provider_type VARCHAR(50) NOT NULL DEFAULT 'seam',
  credential_type VARCHAR(50) NOT NULL DEFAULT 'guest',
  external_credential_id VARCHAR(255),
  access_code VARCHAR(100),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  status VARCHAR(50) DEFAULT 'active',
  allowed_rooms UUID[] DEFAULT '{}',
  allowed_facilities UUID[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_credentials_booking ON access_credentials(booking_id);
CREATE INDEX IF NOT EXISTS idx_credentials_status ON access_credentials(status);
CREATE INDEX IF NOT EXISTS idx_room_devices_hotel ON room_devices(hotel_id);
CREATE INDEX IF NOT EXISTS idx_access_providers_hotel ON access_providers(hotel_id);
