import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";

export const packagesRouter = Router();
packagesRouter.use(requireAuth);

packagesRouter.get("/", asyncHandler(async (req, res) => {
  const pkgs = (await query(
    "SELECT * FROM packages WHERE hotel_id = $1 ORDER BY name",
    [req.user.hotelId]
  )).rows;
  for (const pkg of pkgs) {
    const fids = (await query(
      "SELECT facility_id FROM package_facilities WHERE package_id = $1",
      [pkg.id]
    )).rows;
    pkg.facility_ids = fids.map(r => r.facility_id);
  }
  res.json(pkgs);
}));

packagesRouter.post("/", asyncHandler(async (req, res) => {
  const body = z.object({
    name:        z.string().min(2),
    description: z.string().optional().default(""),
    price:       z.number().min(0),
    facilityIds: z.array(z.string().uuid()).default([])
  }).parse(req.body);

  const pkg = (await query(
    `INSERT INTO packages (hotel_id, name, description, price)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.user.hotelId, body.name, body.description, body.price]
  )).rows[0];

  for (const facilityId of body.facilityIds) {
    await query(
      "INSERT INTO package_facilities (package_id, facility_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [pkg.id, facilityId]
    );
  }
  res.status(201).json({ ...pkg, facility_ids: body.facilityIds });
}));

packagesRouter.put("/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    name:        z.string().min(2).optional(),
    description: z.string().optional(),
    price:       z.number().min(0).optional(),
    facilityIds: z.array(z.string().uuid()).optional()
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE packages SET
       name        = COALESCE($3, name),
       description = COALESCE($4, description),
       price       = COALESCE($5, price)
     WHERE id = $1 AND hotel_id = $2 RETURNING *`,
    [req.params.id, req.user.hotelId, body.name, body.description, body.price]
  );
  if (!rows.length) throw new HttpError(404, "Package not found");

  if (body.facilityIds) {
    await query("DELETE FROM package_facilities WHERE package_id = $1", [req.params.id]);
    for (const facilityId of body.facilityIds) {
      await query(
        "INSERT INTO package_facilities (package_id, facility_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [req.params.id, facilityId]
      );
    }
  }
  res.json({ ...rows[0], facility_ids: body.facilityIds ?? [] });
}));

packagesRouter.delete("/:id", asyncHandler(async (req, res) => {
  await query("DELETE FROM packages WHERE id = $1 AND hotel_id = $2", [req.params.id, req.user.hotelId]);
  res.status(204).end();
}));
