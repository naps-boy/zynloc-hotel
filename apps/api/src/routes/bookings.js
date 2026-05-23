import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { createBookingFromDraft } from "../services/bookings.js";
import { emitHotel } from "../services/realtime.js";
import { asyncHandler, HttpError } from "../utils/http.js";
import { sendBookingConfirmation } from "../services/email.js";
import { query as dbQuery } from "../db/pool.js";

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
  facilityIds:  z.array(z.string().uuid()).default([]),
  specialNotes: z.string().optional().default("")
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
       JOIN guests g ON g.id = b.guest_id
       JOIN rooms  r ON r.id = b.room_id
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
  await sendBookingConfirmation({
    guest: { name: b.guest_name, email: b.guest_email },
    hotel,
    booking: b,
    qr: { token: b.qr_token, qr_data_url: b.qr_data_url },
    managerEmail: req.user.email,
  });
  res.json({ ok: true });
}));

// Receptionist scans a rotating check-in QR token
bookingsRouter.post("/scan-checkin", asyncHandler(async (req, res) => {
  const { token } = z.object({ token: z.string() }).parse(req.body);
  const { rows } = await query(
    `SELECT b.*, g.name guest_name, g.email guest_email, g.selfie_url, g.profile_complete,
            g.face_descriptor, r.number room_number, r.type room_type,
            p.name package_name
       FROM bookings b
       JOIN guests   g ON g.id = b.guest_id
       JOIN rooms    r ON r.id = b.room_id
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
