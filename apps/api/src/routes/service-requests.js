import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { emitHotel } from "../services/realtime.js";
import { asyncHandler, HttpError } from "../utils/http.js";

export const serviceRequestsRouter = Router();
serviceRequestsRouter.use(requireAuth);

serviceRequestsRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT sr.*, g.name guest_name, g.selfie_url, r.number room_number,
            s.name assigned_staff_name
       FROM service_requests sr
       JOIN guests  g ON g.id = sr.guest_id
       JOIN bookings b ON b.id = sr.booking_id
       JOIN rooms   r ON r.id = b.room_id
       LEFT JOIN staff s ON s.id = sr.assigned_staff_id
      WHERE sr.hotel_id = $1
      ORDER BY sr.created_at DESC`,
    [req.user.hotelId]
  );
  res.json(rows);
}));

serviceRequestsRouter.put("/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    status:          z.enum(["open","in_progress","completed"]).optional(),
    assignedStaffId: z.string().uuid().optional().nullable()
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE service_requests SET
       status            = COALESCE($3, status),
       assigned_staff_id = COALESCE($4, assigned_staff_id)
     WHERE id = $1 AND hotel_id = $2 RETURNING *`,
    [req.params.id, req.user.hotelId, body.status, body.assignedStaffId]
  );
  if (!rows.length) throw new HttpError(404, "Request not found");
  emitHotel(req.user.hotelId, "service-requests:updated", rows[0]);
  res.json(rows[0]);
}));
