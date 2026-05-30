import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { emitHotel } from "../services/realtime.js";
import { asyncHandler } from "../utils/http.js";
import { cache } from "../services/cache.js";

export const roomsRouter = Router();
roomsRouter.use(requireAuth);

const roomSchema = z.object({
  number: z.string().min(1),
  type: z.enum(["single", "double", "suite", "villa"]),
  status: z.enum(["free", "occupied", "cleaning"]).default("free"),
  pricePerNight: z.coerce.number().nonnegative(),
  imageUrl: z.string().optional().default(""),
  features: z.array(z.string()).optional().default([]),
  zone: z.string().optional().default("")
});

roomsRouter.get("/", asyncHandler(async (req, res) => {
  const cacheKey = `rooms:${req.user.hotelId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const { rows } = await query("SELECT * FROM rooms WHERE hotel_id = $1 ORDER BY number", [req.user.hotelId]);
  cache.set(cacheKey, rows);
  res.json(rows);
}));

roomsRouter.post("/", asyncHandler(async (req, res) => {
  const body = roomSchema.parse(req.body);
  const { rows } = await query(
    `INSERT INTO rooms (hotel_id, number, type, status, price_per_night, image_url, features, zone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [req.user.hotelId, body.number, body.type, body.status, body.pricePerNight, body.imageUrl, JSON.stringify(body.features), body.zone]
  );
  cache.del(`rooms:${req.user.hotelId}`);
  emitHotel(req.user.hotelId, "rooms:changed", rows[0]);
  res.status(201).json(rows[0]);
}));

roomsRouter.put("/:id", asyncHandler(async (req, res) => {
  const body = roomSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE rooms SET
      number = COALESCE($3, number),
      type = COALESCE($4, type),
      status = COALESCE($5, status),
      price_per_night = COALESCE($6, price_per_night),
      image_url = COALESCE($7, image_url),
      features = COALESCE($8, features),
      zone = COALESCE($9, zone)
     WHERE id = $1 AND hotel_id = $2 RETURNING *`,
    [req.params.id, req.user.hotelId, body.number, body.type, body.status, body.pricePerNight, body.imageUrl, body.features ? JSON.stringify(body.features) : undefined, body.zone]
  );
  cache.del(`rooms:${req.user.hotelId}`);
  emitHotel(req.user.hotelId, "rooms:changed", rows[0]);
  res.json(rows[0]);
}));

roomsRouter.delete("/:id", asyncHandler(async (req, res) => {
  await query("DELETE FROM rooms WHERE id = $1 AND hotel_id = $2", [req.params.id, req.user.hotelId]);
  cache.del(`rooms:${req.user.hotelId}`);
  emitHotel(req.user.hotelId, "rooms:changed", { id: req.params.id, deleted: true });
  res.status(204).end();
}));
