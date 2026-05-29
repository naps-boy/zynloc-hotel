import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";

export const navigationRouter = Router();
navigationRouter.use(requireAuth);

// ─── Floor plan ───────────────────────────────────────────────────────────────

navigationRouter.get("/floor-plan", asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM floor_plans WHERE hotel_id = $1 LIMIT 1",
    [req.user.hotelId]
  );
  res.json(rows[0] || null);
}));

navigationRouter.post("/floor-plan", asyncHandler(async (req, res) => {
  const body = z.object({
    imageData: z.string().min(10),
    width:     z.number().optional().default(800),
    height:    z.number().optional().default(600),
  }).parse(req.body);

  // Upsert — replace existing floor plan if one exists
  const { rows } = await query(
    `INSERT INTO floor_plans (hotel_id, image_data, width, height)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (hotel_id) DO UPDATE
       SET image_data = EXCLUDED.image_data,
           width      = EXCLUDED.width,
           height     = EXCLUDED.height
     RETURNING *`,
    [req.user.hotelId, body.imageData, body.width, body.height]
  );
  res.status(201).json(rows[0]);
}));

// ─── Waypoints ────────────────────────────────────────────────────────────────

navigationRouter.get("/waypoints", asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM navigation_waypoints WHERE hotel_id = $1 ORDER BY name",
    [req.user.hotelId]
  );
  res.json(rows);
}));

navigationRouter.post("/waypoints", asyncHandler(async (req, res) => {
  const body = z.object({
    name:         z.string().min(1),
    photoData:    z.string().optional().default(""),
    photoUrl:     z.string().optional().default(""),
    xPercent:     z.number().min(0).max(100).default(50),
    yPercent:     z.number().min(0).max(100).default(50),
    x:            z.number().optional().default(0),
    y:            z.number().optional().default(0),
    waypointType: z.enum(["corridor","room","facility","entrance","elevator"]).default("corridor"),
    refId:        z.string().uuid().optional().nullable(),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO navigation_waypoints
       (hotel_id, name, photo_url, photo_data, x, y, x_percent, y_percent, waypoint_type, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      req.user.hotelId, body.name,
      body.photoUrl, body.photoData,
      body.x, body.y, body.xPercent, body.yPercent,
      body.waypointType, body.refId ?? null,
    ]
  );
  res.status(201).json(rows[0]);
}));

navigationRouter.put("/waypoints/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    name:         z.string().optional(),
    photoData:    z.string().optional(),
    photoUrl:     z.string().optional(),
    x:            z.number().optional(),
    y:            z.number().optional(),
    xPercent:     z.number().optional(),
    yPercent:     z.number().optional(),
    waypointType: z.string().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE navigation_waypoints SET
       name          = COALESCE($3,  name),
       photo_url     = COALESCE($4,  photo_url),
       photo_data    = COALESCE($5,  photo_data),
       x             = COALESCE($6,  x),
       y             = COALESCE($7,  y),
       x_percent     = COALESCE($8,  x_percent),
       y_percent     = COALESCE($9,  y_percent),
       waypoint_type = COALESCE($10, waypoint_type)
     WHERE id = $1 AND hotel_id = $2 RETURNING *`,
    [
      req.params.id, req.user.hotelId,
      body.name, body.photoUrl, body.photoData,
      body.x, body.y, body.xPercent, body.yPercent, body.waypointType,
    ]
  );
  if (!rows.length) throw new HttpError(404, "Waypoint not found");
  res.json(rows[0]);
}));

navigationRouter.delete("/waypoints/:id", asyncHandler(async (req, res) => {
  await query("DELETE FROM navigation_waypoints WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]);
  res.status(204).end();
}));

// ─── Connections ──────────────────────────────────────────────────────────────

navigationRouter.get("/connections", asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM navigation_connections WHERE hotel_id = $1",
    [req.user.hotelId]
  );
  res.json(rows);
}));

navigationRouter.post("/connections", asyncHandler(async (req, res) => {
  const body = z.object({
    fromWaypointId: z.string().uuid(),
    toWaypointId:   z.string().uuid(),
    distance:       z.number().min(0).default(1),
    directionHint:  z.string().optional().default(""),
    bidirectional:  z.boolean().default(true),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO navigation_connections (hotel_id, from_waypoint_id, to_waypoint_id, distance, direction_hint)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`,
    [req.user.hotelId, body.fromWaypointId, body.toWaypointId, body.distance, body.directionHint]
  );
  if (body.bidirectional) {
    await query(
      `INSERT INTO navigation_connections (hotel_id, from_waypoint_id, to_waypoint_id, distance, direction_hint)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [req.user.hotelId, body.toWaypointId, body.fromWaypointId, body.distance, body.directionHint]
    );
  }
  res.status(201).json(rows[0] || { ok: true });
}));

navigationRouter.delete("/connections/:id", asyncHandler(async (req, res) => {
  await query("DELETE FROM navigation_connections WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]);
  res.status(204).end();
}));
