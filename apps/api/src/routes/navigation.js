import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";

export const navigationRouter = Router();
navigationRouter.use(requireAuth);

// ─── GET /api/navigation — all floor plans + waypoints + paths for this hotel ──

navigationRouter.get("/", asyncHandler(async (req, res) => {
  const { rows: floors } = await query(
    "SELECT * FROM floor_plans WHERE hotel_id = $1 ORDER BY floor_number",
    [req.user.hotelId]
  );
  const { rows: waypoints } = await query(
    "SELECT * FROM nav_waypoints WHERE hotel_id = $1 ORDER BY name",
    [req.user.hotelId]
  );
  const { rows: paths } = await query(
    "SELECT * FROM nav_paths WHERE hotel_id = $1",
    [req.user.hotelId]
  );
  res.json({ floors, waypoints, paths });
}));

// ─── Floors ────────────────────────────────────────────────────────────────────

navigationRouter.post("/floors", asyncHandler(async (req, res) => {
  const body = z.object({
    floorNumber: z.number().int().min(0).default(1),
    floorName:   z.string().min(1),
    imageData:   z.string().min(10),
    width:       z.number().optional().default(800),
    height:      z.number().optional().default(600),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO floor_plans (hotel_id, floor_number, floor_name, image_data, width, height)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (hotel_id, floor_number) DO UPDATE
       SET floor_name = EXCLUDED.floor_name,
           image_data = EXCLUDED.image_data,
           width      = EXCLUDED.width,
           height     = EXCLUDED.height
     RETURNING *`,
    [req.user.hotelId, body.floorNumber, body.floorName, body.imageData, body.width, body.height]
  );
  res.status(201).json(rows[0]);
}));

navigationRouter.delete("/floors/:id", asyncHandler(async (req, res) => {
  await query("DELETE FROM floor_plans WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]);
  res.status(204).end();
}));

// ─── Waypoints ────────────────────────────────────────────────────────────────

navigationRouter.post("/waypoints", asyncHandler(async (req, res) => {
  const body = z.object({
    floorPlanId:   z.string().uuid(),
    name:          z.string().min(1),
    xPercent:      z.number().min(0).max(100),
    yPercent:      z.number().min(0).max(100),
    photoData:     z.string().optional().nullable().default(null),
    waypointType:  z.enum(["junction","entrance","room","facility","stairs"]).default("junction"),
    roomId:        z.string().uuid().optional().nullable(),
    facilityId:    z.string().uuid().optional().nullable(),
    isEntrance:    z.boolean().default(false),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO nav_waypoints
       (hotel_id, floor_plan_id, name, x_percent, y_percent, photo_data,
        waypoint_type, room_id, facility_id, is_entrance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      req.user.hotelId, body.floorPlanId, body.name, body.xPercent, body.yPercent,
      body.photoData, body.waypointType, body.roomId ?? null, body.facilityId ?? null,
      body.isEntrance,
    ]
  );
  res.status(201).json(rows[0]);
}));

navigationRouter.put("/waypoints/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    name:         z.string().optional(),
    xPercent:     z.number().optional(),
    yPercent:     z.number().optional(),
    photoData:    z.string().nullable().optional(),
    waypointType: z.string().optional(),
    roomId:       z.string().uuid().nullable().optional(),
    facilityId:   z.string().uuid().nullable().optional(),
    isEntrance:   z.boolean().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE nav_waypoints SET
       name          = COALESCE($3,  name),
       x_percent     = COALESCE($4,  x_percent),
       y_percent     = COALESCE($5,  y_percent),
       photo_data    = COALESCE($6,  photo_data),
       waypoint_type = COALESCE($7,  waypoint_type),
       room_id       = COALESCE($8,  room_id),
       facility_id   = COALESCE($9,  facility_id),
       is_entrance   = COALESCE($10, is_entrance)
     WHERE id = $1 AND hotel_id = $2 RETURNING *`,
    [
      req.params.id, req.user.hotelId, body.name, body.xPercent, body.yPercent,
      body.photoData, body.waypointType, body.roomId, body.facilityId, body.isEntrance,
    ]
  );
  if (!rows.length) throw new HttpError(404, "Waypoint not found");
  res.json(rows[0]);
}));

navigationRouter.delete("/waypoints/:id", asyncHandler(async (req, res) => {
  await query("DELETE FROM nav_waypoints WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]);
  res.status(204).end();
}));

// ─── Paths ────────────────────────────────────────────────────────────────────

navigationRouter.post("/paths", asyncHandler(async (req, res) => {
  const body = z.object({
    fromWaypointId: z.string().uuid(),
    toWaypointId:   z.string().uuid(),
    controlPoints:  z.array(z.object({ x: z.number(), y: z.number() })).default([]),
    distance:       z.number().optional().default(1),
  }).parse(req.body);

  // Store both directions so pathfinding is bidirectional
  const { rows: r1 } = await query(
    `INSERT INTO nav_paths (hotel_id, from_waypoint_id, to_waypoint_id, control_points, distance)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user.hotelId, body.fromWaypointId, body.toWaypointId, JSON.stringify(body.controlPoints), body.distance]
  );
  await query(
    `INSERT INTO nav_paths (hotel_id, from_waypoint_id, to_waypoint_id, control_points, distance)
     VALUES ($1,$2,$3,$4,$5)`,
    [req.user.hotelId, body.toWaypointId, body.fromWaypointId, JSON.stringify(body.controlPoints), body.distance]
  );
  res.status(201).json(r1[0]);
}));

navigationRouter.put("/paths/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    controlPoints: z.array(z.object({ x: z.number(), y: z.number() })),
    distance:      z.number().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE nav_paths SET
       control_points = $3,
       distance       = COALESCE($4, distance)
     WHERE id = $1 AND hotel_id = $2 RETURNING *`,
    [req.params.id, req.user.hotelId, JSON.stringify(body.controlPoints), body.distance ?? null]
  );
  if (!rows.length) throw new HttpError(404, "Path not found");
  res.json(rows[0]);
}));

navigationRouter.delete("/paths/:id", asyncHandler(async (req, res) => {
  // Look up the path first so we can delete both directions (A→B and B→A).
  // Paths are always created as pairs in POST /paths — deleting only one ID
  // would orphan the reverse direction and leave ghost edges in the nav graph.
  const { rows: pathRows } = await query(
    "SELECT from_waypoint_id, to_waypoint_id FROM nav_paths WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  );
  if (!pathRows[0]) return res.status(404).json({ error: "Path not found" });

  const { from_waypoint_id, to_waypoint_id } = pathRows[0];

  // Delete both directions in one statement
  await query(
    `DELETE FROM nav_paths
      WHERE hotel_id = $1
        AND (
          (from_waypoint_id = $2 AND to_waypoint_id = $3) OR
          (from_waypoint_id = $3 AND to_waypoint_id = $2)
        )`,
    [req.user.hotelId, from_waypoint_id, to_waypoint_id]
  );
  res.status(204).end();
}));

// ─── Route calculation (Dijkstra) ────────────────────────────────────────────

navigationRouter.get("/route", asyncHandler(async (req, res) => {
  const fromId = z.string().uuid().parse(req.query.from);
  const toId   = z.string().uuid().parse(req.query.to);

  const { rows: waypoints } = await query(
    "SELECT * FROM nav_waypoints WHERE hotel_id = $1",
    [req.user.hotelId]
  );
  const { rows: paths } = await query(
    "SELECT * FROM nav_paths WHERE hotel_id = $1",
    [req.user.hotelId]
  );

  // Build adjacency map
  const adj = {};
  for (const wp of waypoints) adj[wp.id] = [];
  for (const p of paths) {
    if (adj[p.from_waypoint_id]) {
      adj[p.from_waypoint_id].push({
        to:   p.to_waypoint_id,
        dist: Number(p.distance) || 1,
        path: p,
      });
    }
  }

  // Dijkstra
  const dist  = {};
  const prev  = {};
  const pathUsed = {};
  const visited = new Set();
  for (const wp of waypoints) dist[wp.id] = Infinity;
  dist[fromId] = 0;
  const queue = [{ id: fromId, d: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.d - b.d);
    const { id: u } = queue.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === toId) break;
    for (const { to, dist: edgeDist, path } of (adj[u] || [])) {
      const alt = dist[u] + edgeDist;
      if (alt < dist[to]) {
        dist[to] = alt;
        prev[to] = u;
        pathUsed[to] = path;
        queue.push({ id: to, d: alt });
      }
    }
  }

  if (dist[toId] === Infinity) {
    throw new HttpError(404, "No route found between these waypoints");
  }

  // Reconstruct path
  const wpMap = Object.fromEntries(waypoints.map(w => [w.id, w]));
  const idPath = [];
  let cur = toId;
  while (cur !== undefined) { idPath.unshift(cur); cur = prev[cur]; }

  const steps = idPath.map((id, i) => ({
    waypoint:      wpMap[id],
    controlPoints: i > 0 ? (pathUsed[id]?.control_points || []) : [],
  }));

  res.json({ steps, totalDistance: dist[toId] });
}));
