import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/http.js";

export const accessLogRouter = Router();
accessLogRouter.use(requireAuth);

accessLogRouter.get("/", asyncHandler(async (req, res) => {
  const { facility, result, limit = 200 } = req.query;
  const params = [req.user.hotelId];
  let where = "WHERE qs.hotel_id = $1";
  if (facility) { params.push(facility); where += ` AND qs.facility_id = $${params.length}`; }
  if (result)   { params.push(result);   where += ` AND qs.result = $${params.length}`; }

  const { rows } = await query(
    `SELECT qs.id, qs.result, qs.created_at,
            f.name  facility_name,
            g.name  guest_name, g.selfie_url,
            r.number room_number
       FROM qr_scans qs
       LEFT JOIN facilities f  ON f.id  = qs.facility_id
       LEFT JOIN qr_codes   qc ON qc.id = qs.qr_code_id
       LEFT JOIN bookings   b  ON b.id  = qc.booking_id
       LEFT JOIN guests     g  ON g.id  = b.guest_id
       LEFT JOIN rooms      r  ON r.id  = b.room_id
       ${where}
       ORDER BY qs.created_at DESC LIMIT $${params.length + 1}`,
    [...params, Number(limit)]
  );
  res.json(rows);
}));
