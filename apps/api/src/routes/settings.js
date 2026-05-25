import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { ensureCheckoutQr, ensureFacilityQr, ensureReceptionQr } from "../services/qr.js";
import { asyncHandler } from "../utils/http.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get("/", asyncHandler(async (req, res) => {
  const hotel = (await query("SELECT * FROM hotels WHERE id = $1", [req.user.hotelId])).rows[0];
  const checkoutQr = await ensureCheckoutQr(req.user.hotelId);
  res.json({ ...hotel, checkout_qr: checkoutQr });
}));

settingsRouter.put("/", requireRole("manager"), asyncHandler(async (req, res) => {
  const body = z.object({
    name:               z.string().min(2).optional(),
    address:            z.string().optional(),
    logoUrl:            z.string().optional(),
    coverPhotoUrl:      z.string().optional(),
    receptionPhone:     z.string().optional(),
    floorPlanUrl:       z.string().optional(),
    floorPlanMarkers:   z.array(z.any()).optional(),
    onboardingComplete: z.boolean().optional()
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE hotels SET
       name                = COALESCE($2, name),
       address             = COALESCE($3, address),
       logo_url            = COALESCE($4, logo_url),
       cover_photo_url     = COALESCE($5, cover_photo_url),
       reception_phone     = COALESCE($6, reception_phone),
       floor_plan_url      = COALESCE($7, floor_plan_url),
       floor_plan_markers  = COALESCE($8, floor_plan_markers),
       onboarding_complete = COALESCE($9, onboarding_complete)
     WHERE id = $1 RETURNING *`,
    [
      req.user.hotelId,
      body.name ?? null, body.address ?? null, body.logoUrl ?? null, body.coverPhotoUrl ?? null,
      body.receptionPhone ?? null, body.floorPlanUrl ?? null,
      body.floorPlanMarkers !== undefined ? JSON.stringify(body.floorPlanMarkers) : null,
      body.onboardingComplete ?? null
    ]
  );
  res.json(rows[0]);
}));

// Force-regenerate the property-wide checkout QR
settingsRouter.post("/checkout-qr", requireRole("manager"), asyncHandler(async (req, res) => {
  await query("DELETE FROM checkout_qr_codes WHERE hotel_id = $1", [req.user.hotelId]);
  const qr = await ensureCheckoutQr(req.user.hotelId);
  res.json(qr);
}));

// Get (or generate) the rotating reception QR — rotates every 30 min
settingsRouter.get("/reception-qr", asyncHandler(async (req, res) => {
  const qr = await ensureReceptionQr(req.user.hotelId);
  res.json(qr);
}));

// Ensure all facilities have static QRs and return them
settingsRouter.get("/facility-qrs", asyncHandler(async (req, res) => {
  const facilities = (await query(
    "SELECT id, name FROM facilities WHERE hotel_id = $1",
    [req.user.hotelId]
  )).rows;
  const result = [];
  for (const f of facilities) {
    const qr = await ensureFacilityQr({ hotelId: req.user.hotelId, facilityId: f.id });
    result.push({ ...f, ...qr });
  }
  res.json(result);
}));
