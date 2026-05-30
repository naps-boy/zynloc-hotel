ALTER TABLE hotels ADD COLUMN IF NOT EXISTS kyc_required BOOLEAN DEFAULT false;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS kyc_documents JSONB DEFAULT '[]';
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS country VARCHAR(255);

CREATE TABLE IF NOT EXISTS guest_documents (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID         NOT NULL REFERENCES bookings(id)  ON DELETE CASCADE,
  hotel_id   UUID         NOT NULL REFERENCES hotels(id)    ON DELETE CASCADE,
  document_type  VARCHAR(100) NOT NULL,
  document_data  TEXT         NOT NULL,
  uploaded_at    TIMESTAMPTZ  DEFAULT now(),
  delete_at      TIMESTAMPTZ  DEFAULT (now() + INTERVAL '1 year'),
  notified_before_delete BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_guest_docs_booking ON guest_documents(booking_id);
CREATE INDEX IF NOT EXISTS idx_guest_docs_hotel   ON guest_documents(hotel_id);
CREATE INDEX IF NOT EXISTS idx_guest_docs_delete  ON guest_documents(delete_at);
