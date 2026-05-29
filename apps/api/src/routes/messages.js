import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { emitHotel, emitBooking } from "../services/realtime.js";
import { asyncHandler } from "../utils/http.js";

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

// GET /api/messages — all messages for the hotel (most recent 100)
// read_at column is included via m.* — frontend computes unread counts
messagesRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT m.*, g.name guest_name, s.name staff_name, s.display_name staff_display_name
       FROM messages m
       LEFT JOIN guests g ON g.id = m.guest_id
       LEFT JOIN staff s ON s.id = m.staff_id
      WHERE m.hotel_id = $1
      ORDER BY m.created_at DESC LIMIT 200`,
    [req.user.hotelId]
  );
  res.json(rows);
}));

// POST /api/messages — staff sends message to a specific guest
messagesRouter.post("/", asyncHandler(async (req, res) => {
  const body = z.object({
    guestId: z.string().uuid().optional(),
    body: z.string().min(1),
    broadcast: z.boolean().default(false)
  }).parse(req.body);

  const { rows: staffRows } = await query(
    "SELECT display_name, name FROM staff WHERE id = $1",
    [req.user.staffId]
  );
  const senderDisplayName = staffRows[0]?.display_name || staffRows[0]?.name || "Staff";

  const { rows } = await query(
    `INSERT INTO messages (hotel_id, guest_id, staff_id, sender, body, broadcast, sender_display_name)
     VALUES ($1, $2, $3, 'staff', $4, $5, $6) RETURNING *`,
    [req.user.hotelId, body.guestId, req.user.staffId, body.body, body.broadcast, senderDisplayName]
  );
  const msg = rows[0];
  emitHotel(req.user.hotelId, "messages:new", msg);

  // Also push to the guest's booking room for real-time delivery
  if (body.guestId) {
    const { rows: bookingRows } = await query(
      "SELECT id FROM bookings WHERE hotel_id = $1 AND guest_id = $2 AND status = 'current' LIMIT 1",
      [req.user.hotelId, body.guestId]
    );
    if (bookingRows[0]) emitBooking(bookingRows[0].id, "messages:new", msg);
  }

  res.status(201).json(msg);
}));

// POST /api/messages/mark-read — mark all guest messages in a conversation as read
messagesRouter.post("/mark-read", asyncHandler(async (req, res) => {
  const { guestId } = z.object({ guestId: z.string().uuid() }).parse(req.body);
  await query(
    `UPDATE messages SET read_at = NOW()
      WHERE hotel_id = $1 AND guest_id = $2 AND sender = 'guest' AND read_at IS NULL`,
    [req.user.hotelId, guestId]
  );
  res.json({ ok: true });
}));

// POST /api/messages/broadcast — send emergency message to all checked-in guests
messagesRouter.post("/broadcast", asyncHandler(async (req, res) => {
  const { body: msgBody } = z.object({ body: z.string().min(1).max(500) }).parse(req.body);

  const { rows: staffRows } = await query(
    "SELECT display_name, name FROM staff WHERE id = $1",
    [req.user.staffId]
  );
  const senderDisplayName = staffRows[0]?.display_name || staffRows[0]?.name || "Staff";

  // Insert one broadcast message (guest_id = NULL, broadcast = TRUE)
  // Guests see it via: WHERE guest_id = $guestId OR broadcast = TRUE
  const { rows } = await query(
    `INSERT INTO messages (hotel_id, guest_id, staff_id, sender, body, broadcast, sender_display_name)
     VALUES ($1, NULL, $2, 'staff', $3, TRUE, $4) RETURNING *`,
    [req.user.hotelId, req.user.staffId, msgBody, senderDisplayName]
  );
  const msg = rows[0];

  // Emit to every current guest's booking room for real-time delivery
  const { rows: bookings } = await query(
    "SELECT id FROM bookings WHERE hotel_id = $1 AND status = 'current'",
    [req.user.hotelId]
  );
  for (const b of bookings) {
    emitBooking(b.id, "messages:new", msg);
  }

  // Notify manager tabs too
  emitHotel(req.user.hotelId, "messages:new", msg);

  res.status(201).json({ ok: true, count: bookings.length, message: msg });
}));
