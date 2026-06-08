import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";
import { cache } from "../services/cache.js";

export const packagesRouter = Router();
packagesRouter.use(requireAuth);

packagesRouter.get("/", asyncHandler(async (req, res) => {
  const cacheKey = `packages:${req.user.hotelId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const pkgs = (await query(
    "SELECT * FROM packages WHERE hotel_id = $1 ORDER BY name",
    [req.user.hotelId]
  )).rows;

  // Batch-load all facility associations in one query (avoids N+1)
  const facilityMap = {};
  if (pkgs.length) {
    const fRows = (await query(
      `SELECT package_id, array_agg(facility_id) AS facility_ids
         FROM package_facilities
        WHERE package_id = ANY($1)
        GROUP BY package_id`,
      [pkgs.map(p => p.id)]
    )).rows;
    for (const r of fRows) facilityMap[r.package_id] = r.facility_ids;
  }

  const result = pkgs.map(p => ({ ...p, facility_ids: facilityMap[p.id] || [] }));
  cache.set(cacheKey, result);
  res.json(result);
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
  cache.del(`packages:${req.user.hotelId}`);
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
  cache.del(`packages:${req.user.hotelId}`);
  res.json({ ...rows[0], facility_ids: body.facilityIds ?? [] });
}));

packagesRouter.delete("/:id", asyncHandler(async (req, res) => {
  await query("DELETE FROM packages WHERE id = $1 AND hotel_id = $2", [req.params.id, req.user.hotelId]);
  cache.del(`packages:${req.user.hotelId}`);
  res.status(204).end();
}));
