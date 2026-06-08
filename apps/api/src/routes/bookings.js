import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { createBookingFromDraft } from "../services/bookings.js";
import { emitHotel, emitBooking } from "../services/realtime.js";
import { asyncHandler, HttpError } from "../utils/http.js";
import { sendBookingConfirmation } from "../services/email.js";

export const bookingsRouter = Router();
bookingsRouter.use(requireAuth);

const bookingSchema = z.object({
  guestName:    z.string().min(2),
  guestEmail:   z.string().email(),
  guestPhone:   z.string().optional().default(""),
  roomId:       z.string().uuid(),
  packageId:    z.preprocess(v => (v === "" ? null : v), z.string().uuid().optional().nullable()),
  packageType:  z.string().default("standard"),
  checkIn:      z.coerce.date(),
  checkOut:     z.coerce.date(),
  facilityIds:   z.array(z.string().uuid()).default([]),
  specialNotes:  z.string().optional().default(""),
  bookingSource: z.string().optional().default("manual"),
});

bookingsRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT b.*,
            g.name guest_name, g.email guest_email, g.phone guest_phone_num,
            g.selfie_url, g.profile_complete,
            r.number room_number, r.type room_type,
            q.token qr_token, q.qr_data_url,
            p.name package_name
       FROM bookings b
       LEFT JOIN guests g ON g.id = b.guest_id
       LEFT JOIN rooms  r ON r.id = b.room_id
       LEFT JOIN qr_codes q ON q.booking_id = b.id
       LEFT JOIN packages p ON p.id = b.package_id
      WHERE b.hotel_id = $1
      ORDER BY b.check_in DESC`,
    [req.user.hotelId]
  );
  res.json(rows);
}));

bookingsRouter.post("/", asyncHandler(async (req, res) => {
  const body = bookingSchema.parse(req.body);
  const booking = await createBookingFromDraft({ hotelId: req.user.hotelId, draft: body });
  res.status(201).json(booking);
}));

// Resend confirmation email
bookingsRouter.post("/:id/resend-email", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT b.*, g.name guest_name, g.email guest_email, r.number room_number,
            q.token qr_token, q.qr_data_url
       FROM bookings b
       JOIN guests   g ON g.id = b.guest_id
       JOIN rooms    r ON r.id = b.room_id
       JOIN qr_codes q ON q.booking_id = b.id
      WHERE b.id = $1 AND b.hotel_id = $2`,
    [req.params.id, req.user.hotelId]
  );
  if (!rows.length) throw new HttpError(404, "Booking not found");
  const b = rows[0];
  const hotel = (await query("SELECT * FROM hotels WHERE id = $1", [req.user.hotelId])).rows[0];
  const messageId = await sendBookingConfirmation({
    guest: { name: b.guest_name, email: b.guest_email },
    hotel,
    booking: b,
    qr: { token: b.qr_token, qr_data_url: b.qr_data_url },
    hotelId: req.user.hotelId,
  });
  res.json({ ok: true, messageId: messageId || null });
}));

// Receptionist scans a rotating check-in QR token → returns guest details for visual confirmation
bookingsRouter.post("/scan-checkin", asyncHandler(async (req, res) => {
  const { token } = z.object({ token: z.string() }).parse(req.body);
  const { rows } = await query(
    `SELECT b.*,
            g.name guest_name, g.email guest_email, g.selfie_url, g.profile_complete,
            r.number room_number, r.type room_type,
            q.token qr_token,
            p.name package_name,
            COALESCE(
              (SELECT json_agg(f.name ORDER BY f.name)
                 FROM facility_access fa
                 JOIN facilities f ON f.id = fa.facility_id
                WHERE fa.booking_id = b.id AND fa.included = TRUE),
              '[]'::json
            ) AS facilities
       FROM bookings b
       JOIN guests   g ON g.id = b.guest_id
       JOIN rooms    r ON r.id = b.room_id
       JOIN qr_codes q ON q.booking_id = b.id
       LEFT JOIN packages p ON p.id = b.package_id
      WHERE b.checkin_token = $1 AND b.hotel_id = $2`,
    [token, req.user.hotelId]
  );
  if (!rows.length) throw new HttpError(404, "QR not recognised");
  const b = rows[0];
  if (new Date(b.checkin_token_expires_at) < new Date()) {
    throw new HttpError(410, "QR has expired — ask guest to refresh their app");
  }
  res.json(b);
}));

// Revoke guest access immediately
bookingsRouter.post("/:id/revoke", asyncHandler(async (req, res) => {
  const { rows } = await query(
    "UPDATE bookings SET revoked = TRUE WHERE id = $1 AND hotel_id = $2 RETURNING *",
    [req.params.id, req.user.hotelId]
  );
  if (!rows.length) throw new HttpError(404, "Booking not found");
  emitBooking(req.params.id, "access:revoked", { bookingId: req.params.id });
  emitHotel(req.user.hotelId, "bookings:changed", rows[0]);
  res.json(rows[0]);
}));

// Restore revoked access
bookingsRouter.post("/:id/restore", asyncHandler(async (req, res) => {
  const { rows } = await query(
    "UPDATE bookings SET revoked = FALSE WHERE id = $1 AND hotel_id = $2 RETURNING *",
    [req.params.id, req.user.hotelId]
  );
  if (!rows.length) throw new HttpError(404, "Booking not found");
  emitBooking(req.params.id, "access:restored", { bookingId: req.params.id });
  emitHotel(req.user.hotelId, "bookings:changed", rows[0]);
  res.json(rows[0]);
}));

bookingsRouter.put("/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    roomId:      z.string().uuid().optional(),
    checkOut:    z.coerce.date().optional(),
    status:      z.enum(["upcoming","current","past","cancelled"]).optional(),
    specialNotes:z.string().optional()
  }).parse(req.body);
  const { rows } = await query(
    `UPDATE bookings SET
       room_id       = COALESCE($3, room_id),
       check_out     = COALESCE($4, check_out),
       status        = COALESCE($5, status),
       special_notes = COALESCE($6, special_notes)
     WHERE id = $1 AND hotel_id = $2 RETURNING *`,
    [req.params.id, req.user.hotelId, body.roomId, body.checkOut, body.status, body.specialNotes]
  );
  if (!rows.length) throw new HttpError(404, "Booking not found");
  emitHotel(req.user.hotelId, "bookings:changed", rows[0]);
  res.json(rows[0]);
}));

bookingsRouter.delete("/:id", asyncHandler(async (req, res) => {
  const { rows } = await query(
    "UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND hotel_id = $2 RETURNING *",
    [req.params.id, req.user.hotelId]
  );
  if (!rows.length) throw new HttpError(404, "Booking not found");
  emitHotel(req.user.hotelId, "bookings:changed", rows[0]);
  res.json(rows[0]);
}));

// ─── KYC document management (manager-only) ───────────────────────────────────

// GET /:id/documents — list documents for a booking (no document_data)
bookingsRouter.get("/:id/documents", asyncHandler(async (req, res) => {
  // Verify booking belongs to this hotel
  const booking = (await query(
    "SELECT id FROM bookings WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  )).rows[0];
  if (!booking) throw new HttpError(404, "Booking not found");

  const { rows } = await query(
    `SELECT id, document_type, uploaded_at, delete_at
       FROM guest_documents
      WHERE booking_id = $1 AND hotel_id = $2
      ORDER BY uploaded_at DESC`,
    [req.params.id, req.user.hotelId]
  );
  res.json(rows);
}));

// GET /:id/documents/:docId/view — view a single document including data
bookingsRouter.get("/:id/documents/:docId/view", asyncHandler(async (req, res) => {
  const booking = (await query(
    "SELECT id FROM bookings WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  )).rows[0];
  if (!booking) throw new HttpError(404, "Booking not found");

  const { rows } = await query(
    `SELECT id, document_type, document_data, uploaded_at, delete_at
       FROM guest_documents
      WHERE id = $1 AND booking_id = $2 AND hotel_id = $3`,
    [req.params.docId, req.params.id, req.user.hotelId]
  );
  if (!rows.length) throw new HttpError(404, "Document not found");
  res.json(rows[0]);
}));

// DELETE /:id/documents/:docId — manager deletes a document
bookingsRouter.delete("/:id/documents/:docId", asyncHandler(async (req, res) => {
  const booking = (await query(
    "SELECT id FROM bookings WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  )).rows[0];
  if (!booking) throw new HttpError(404, "Booking not found");

  await query(
    "DELETE FROM guest_documents WHERE id = $1 AND booking_id = $2 AND hotel_id = $3",
    [req.params.docId, req.params.id, req.user.hotelId]
  );
  res.status(204).end();
}));
