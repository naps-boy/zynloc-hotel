import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { emitHotel } from "../services/realtime.js";
import { asyncHandler } from "../utils/http.js";

export const guestsRouter = Router();
guestsRouter.use(requireAuth);

guestsRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT g.*,
            b.id          booking_id,
            b.check_in,
            b.check_out,
            b.package_type,
            b.status      booking_status,
            b.revoked,
            b.profile_status,
            r.number      room_number,
            r.type        room_type
       FROM guests g
       LEFT JOIN bookings b ON b.guest_id = g.id AND b.status <> 'cancelled'
       LEFT JOIN rooms r ON r.id = b.room_id
      WHERE g.hotel_id = $1
      ORDER BY b.check_in DESC NULLS LAST, g.name`,
    [req.user.hotelId]
  );
  res.json(rows);
}));

guestsRouter.put("/:id/location", asyncHandler(async (req, res) => {
  const body = z.object({ currentLocation: z.string().min(1) }).parse(req.body);
  const { rows } = await query(
    "UPDATE guests SET current_location = $3 WHERE id = $1 AND hotel_id = $2 RETURNING *",
    [req.params.id, req.user.hotelId, body.currentLocation]
  );
  emitHotel(req.user.hotelId, "guests:location", rows[0]);
  res.json(rows[0]);
}));
