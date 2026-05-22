import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";

export const navigationRouter = Router();
navigationRouter.use(requireAuth);

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
    photoUrl:     z.string().optional().default(""),
    x:            z.number().min(0).max(100).default(0),
    y:            z.number().min(0).max(100).default(0),
    waypointType: z.enum(["corridor","room","facility","entrance","elevator"]).default("corridor"),
    refId:        z.string().uuid().optional().nullable()
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO navigation_waypoints (hotel_id, name, photo_url, x, y, waypoint_type, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.hotelId, body.name, body.photoUrl, body.x, body.y, body.waypointType, body.refId ?? null]
  );
  res.status(201).json(rows[0]);
}));

navigationRouter.put("/waypoints/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    name:         z.string().optional(),
    photoUrl:     z.string().optional(),
    x:            z.number().optional(),
    y:            z.number().optional(),
    waypointType: z.string().optional()
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE navigation_waypoints SET
       name          = COALESCE($3, name),
       photo_url     = COALESCE($4, photo_url),
       x             = COALESCE($5, x),
       y             = COALESCE($6, y),
       waypoint_type = COALESCE($7, waypoint_type)
     WHERE id = $1 AND hotel_id = $2 RETURNING *`,
    [req.params.id, req.user.hotelId, body.name, body.photoUrl, body.x, body.y, body.waypointType]
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
    bidirectional:  z.boolean().default(true)
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
  res.status(201).json(rows[0]);
}));

navigationRouter.delete("/connections/:id", asyncHandler(async (req, res) => {
  await query("DELETE FROM navigation_connections WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]);
  res.status(204).end();
}));
