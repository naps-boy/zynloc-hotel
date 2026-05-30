import crypto from "node:crypto";
import QRCode from "qrcode";
import { config } from "../config.js";
import { query } from "../db/pool.js";

const QR_OPTS = { margin: 2, width: 360, color: { dark: "#0d1b2a", light: "#ffffff" } };

// ─── Guest access QR (long-lived, embedded in email link) ────────────────────
export async function createBookingQr({ hotelId, bookingId, expiresAt }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const url = `${config.clientUrl}/guest/${token}`;
  const qrDataUrl = await QRCode.toDataURL(url, QR_OPTS);
  const { rows } = await query(
    `INSERT INTO qr_codes (hotel_id, booking_id, token, qr_data_url, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [hotelId, bookingId, token, qrDataUrl, expiresAt]
  );
  return rows[0];
}

// ─── Rotating check-in QR (shown in guest app, 15-min window) ────────────────
export async function rotateCheckinQr(bookingId) {
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const url = `${config.clientUrl}/checkin-scan/${token}`;
  await query(
    `UPDATE bookings SET checkin_token = $1, checkin_token_expires_at = $2 WHERE id = $3`,
    [token, expiresAt, bookingId]
  );
  const qrDataUrl = await QRCode.toDataURL(url, QR_OPTS);
  return { token, expires_at: expiresAt, qr_data_url: qrDataUrl };
}

// ─── Static facility QR (printed, never rotates) ─────────────────────────────
export async function ensureFacilityQr({ hotelId, facilityId }) {
  const existing = await query(
    "SELECT * FROM facility_qr_codes WHERE hotel_id = $1 AND facility_id = $2",
    [hotelId, facilityId]
  );
  if (existing.rows.length) return existing.rows[0];

  const token = crypto.randomBytes(24).toString("base64url");
  const url = `${config.clientUrl}/facility-scan/${token}`;
  const qrDataUrl = await QRCode.toDataURL(url, QR_OPTS);
  const { rows } = await query(
    `INSERT INTO facility_qr_codes (hotel_id, facility_id, token, qr_data_url)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [hotelId, facilityId, token, qrDataUrl]
  );
  return rows[0];
}

// ─── Static checkout QR (one per hotel) ──────────────────────────────────────
export async function ensureCheckoutQr(hotelId) {
  const existing = await query(
    "SELECT * FROM checkout_qr_codes WHERE hotel_id = $1",
    [hotelId]
  );
  if (existing.rows.length) return existing.rows[0];

  const token = crypto.randomBytes(24).toString("base64url");
  const url = `${config.clientUrl}/checkout-scan/${token}`;
  const qrDataUrl = await QRCode.toDataURL(url, QR_OPTS);
  const { rows } = await query(
    `INSERT INTO checkout_qr_codes (hotel_id, token, qr_data_url)
     VALUES ($1, $2, $3) RETURNING *`,
    [hotelId, token, qrDataUrl]
  );
  return rows[0];
}

// ─── Rotating reception QR (shown at front desk, 30-min window) ──────────────
export async function ensureReceptionQr(hotelId) {
  const { rows } = await query(
    "SELECT reception_token, reception_token_expires_at FROM hotels WHERE id = $1",
    [hotelId]
  );
  const hotel = rows[0];
  const expired = !hotel?.reception_token || new Date(hotel.reception_token_expires_at) < new Date();

  if (!expired) {
    // Include hotel ID so /reception-scan page can identify the guest without sessionStorage
    const url = `${config.clientUrl}/reception-scan/${hotel.reception_token}?hotel=${hotelId}`;
    const qrDataUrl = await QRCode.toDataURL(url, QR_OPTS);
    return { token: hotel.reception_token, expires_at: hotel.reception_token_expires_at, qr_data_url: qrDataUrl };
  }

  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const url = `${config.clientUrl}/reception-scan/${token}?hotel=${hotelId}`;
  const qrDataUrl = await QRCode.toDataURL(url, QR_OPTS);
  await query(
    "UPDATE hotels SET reception_token = $1, reception_token_expires_at = $2 WHERE id = $3",
    [token, expiresAt, hotelId]
  );
  return { token, expires_at: expiresAt, qr_data_url: qrDataUrl };
}

// ─── Resolve access token → booking payload ──────────────────────────────────
export async function getQrPayload(token) {
  const { rows } = await query(
    `SELECT q.*, q.id qr_id,
            b.id booking_id, b.package_type, b.check_in, b.check_out, b.status,
            b.revoked, b.profile_status, b.special_notes, b.guest_phone, b.checkin_token,
            b.checkin_token_expires_at, b.package_id,
            g.id guest_id, g.name guest_name, g.email guest_email,
            g.current_location, g.selfie_url, g.profile_complete,
            r.number room_number, r.type room_type,
            h.name hotel_name, h.logo_url, h.address, h.reception_phone,
            h.floor_plan_url, h.floor_plan_markers
       FROM qr_codes q
       JOIN bookings b ON b.id = q.booking_id
       JOIN guests   g ON g.id = b.guest_id
       JOIN rooms    r ON r.id = b.room_id
       JOIN hotels   h ON h.id = q.hotel_id
      WHERE q.token = $1`,
    [token]
  );
  return rows[0];
}
