import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { ensureFacilityQr } from "../services/qr.js";
import { asyncHandler, HttpError } from "../utils/http.js";

export const facilitiesRouter = Router();
facilitiesRouter.use(requireAuth);

facilitiesRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT f.id, f.hotel_id, f.name, f.description, f.zone, f.icon, f.photos, f.created_at,
            COALESCE(active.active_guest_count, 0) active_guest_count,
            fqr.token qr_token, fqr.qr_data_url
       FROM facilities f
       LEFT JOIN (
         SELECT fa.facility_id, COUNT(DISTINCT b.id) active_guest_count
           FROM facility_access fa
           JOIN bookings b ON b.id = fa.booking_id AND b.status IN ('upcoming','current')
          WHERE fa.included = TRUE
          GROUP BY fa.facility_id
       ) active ON active.facility_id = f.id
       LEFT JOIN facility_qr_codes fqr ON fqr.facility_id = f.id AND fqr.hotel_id = f.hotel_id
      WHERE f.hotel_id = $1
      ORDER BY f.name`,
    [req.user.hotelId]
  );
  res.json(rows);
}));

facilitiesRouter.post("/", asyncHandler(async (req, res) => {
  const body = z.object({
    name:        z.string().min(2),
    description: z.string().optional().default(""),
    zone:        z.string().optional().default(""),
    icon:        z.string().optional().default("dumbbell"),
    photos:      z.array(z.string()).optional().default([])
  }).parse(req.body);
  const { rows } = await query(
    `INSERT INTO facilities (hotel_id, name, description, zone, icon, photos)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user.hotelId, body.name, body.description, body.zone, body.icon, JSON.stringify(body.photos)]
  );
  // Auto-generate static QR for this facility
  const qr = await ensureFacilityQr({ hotelId: req.user.hotelId, facilityId: rows[0].id });
  res.status(201).json({ ...rows[0], qr_token: qr?.token, qr_data_url: qr?.qr_data_url });
}));

facilitiesRouter.put("/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    name:        z.string().min(2).optional(),
    description: z.string().optional(),
    zone:        z.string().optional(),
    icon:        z.string().optional(),
    photos:      z.array(z.string()).optional()
  }).parse(req.body);
  const { rows } = await query(
    `UPDATE facilities SET
       name        = COALESCE($3, name),
       description = COALESCE($4, description),
       zone        = COALESCE($5, zone),
       icon        = COALESCE($6, icon),
       photos      = COALESCE($7, photos)
     WHERE id = $1 AND hotel_id = $2 RETURNING *`,
    [req.params.id, req.user.hotelId, body.name, body.description, body.zone, body.icon,
     body.photos ? JSON.stringify(body.photos) : undefined]
  );
  if (!rows.length) throw new HttpError(404, "Facility not found");
  res.json(rows[0]);
}));

facilitiesRouter.delete("/:id", asyncHandler(async (req, res) => {
  await query("DELETE FROM facilities WHERE id = $1 AND hotel_id = $2", [req.params.id, req.user.hotelId]);
  res.status(204).end();
}));

// Regenerate / fetch static QR for a facility
facilitiesRouter.post("/:id/qr", asyncHandler(async (req, res) => {
  // Delete existing so ensureFacilityQr creates a fresh one
  await query("DELETE FROM facility_qr_codes WHERE facility_id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]);
  const qr = await ensureFacilityQr({ hotelId: req.user.hotelId, facilityId: req.params.id });
  res.json(qr);
}));
