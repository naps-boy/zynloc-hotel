import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { emitHotel } from "../services/realtime.js";
import { asyncHandler } from "../utils/http.js";

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

messagesRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT m.*, g.name guest_name, s.name staff_name, s.display_name staff_display_name
       FROM messages m
       LEFT JOIN guests g ON g.id = m.guest_id
       LEFT JOIN staff s ON s.id = m.staff_id
      WHERE m.hotel_id = $1
      ORDER BY m.created_at DESC LIMIT 100`,
    [req.user.hotelId]
  );
  res.json(rows);
}));

messagesRouter.post("/", asyncHandler(async (req, res) => {
  const body = z.object({
    guestId: z.string().uuid().optional(),
    body: z.string().min(1),
    broadcast: z.boolean().default(false)
  }).parse(req.body);

  // Capture sender display name at send time for historical accuracy
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
  emitHotel(req.user.hotelId, "messages:new", rows[0]);
  res.status(201).json(rows[0]);
}));
