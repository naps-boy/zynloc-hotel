import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { emitHotel } from "../services/realtime.js";
import { asyncHandler } from "../utils/http.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM notifications WHERE hotel_id = $1 ORDER BY created_at DESC LIMIT 100",
    [req.user.hotelId]
  );
  res.json(rows);
}));

notificationsRouter.post("/", asyncHandler(async (req, res) => {
  const body = z.object({
    type: z.enum(["checkin", "checkout", "late_checkout", "early_checkin", "message", "service"]),
    title: z.string().min(1),
    body: z.string().min(1),
    guestId: z.string().uuid().optional()
  }).parse(req.body);
  const { rows } = await query(
    `INSERT INTO notifications (hotel_id, guest_id, type, title, body)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.user.hotelId, body.guestId, body.type, body.title, body.body]
  );
  emitHotel(req.user.hotelId, "notifications:new", rows[0]);
  res.status(201).json(rows[0]);
}));

notificationsRouter.put("/:id/read", asyncHandler(async (req, res) => {
  const { rows } = await query(
    "UPDATE notifications SET read_at = NOW() WHERE id = $1 AND hotel_id = $2 RETURNING *",
    [req.params.id, req.user.hotelId]
  );
  if (!rows[0]) return res.status(404).json({ error: "Notification not found" });
  res.json(rows[0]);
}));
