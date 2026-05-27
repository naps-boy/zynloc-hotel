import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../utils/http.js";

export const staffRouter = Router();
staffRouter.use(requireAuth);

staffRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT id, hotel_id, name, email, role, zone, display_name, created_at FROM staff WHERE hotel_id = $1 ORDER BY name",
    [req.user.hotelId]
  );
  res.json(rows);
}));

staffRouter.post("/", requireRole("manager"), asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(["housekeeping", "security", "receptionist", "manager"]),
    zone: z.string().optional().default(""),
    displayName: z.string().optional().default("")
  }).parse(req.body);
  const { rows } = await query(
    `INSERT INTO staff (hotel_id, name, email, password_hash, role, zone, display_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, hotel_id, name, email, role, zone, display_name, created_at`,
    [req.user.hotelId, body.name, body.email.toLowerCase(),
     await bcrypt.hash(body.password, 12), body.role, body.zone,
     body.displayName || null]
  );
  res.status(201).json(rows[0]);
}));

staffRouter.post("/tasks", asyncHandler(async (req, res) => {
  const body = z.object({
    title: z.string().min(2),
    staffId: z.string().uuid().optional(),
    roomId: z.string().uuid().optional()
  }).parse(req.body);
  const { rows } = await query(
    "INSERT INTO tasks (hotel_id, title, staff_id, room_id) VALUES ($1, $2, $3, $4) RETURNING *",
    [req.user.hotelId, body.title, body.staffId, body.roomId]
  );
  res.status(201).json(rows[0]);
}));

staffRouter.put("/tasks/:id", asyncHandler(async (req, res) => {
  const body = z.object({ status: z.string().min(1) }).parse(req.body);
  const { rows } = await query(
    "UPDATE tasks SET status = $3 WHERE id = $1 AND hotel_id = $2 RETURNING *",
    [req.params.id, req.user.hotelId, body.status]
  );
  res.json(rows[0]);
}));
