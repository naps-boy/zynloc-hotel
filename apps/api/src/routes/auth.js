import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAuth, signSession } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";

export const authRouter = Router();

authRouter.post("/register-manager", asyncHandler(async (req, res) => {
  const body = z.object({
    hotelName: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().default("Hotel Manager")
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const hotel = (await client.query(
      "INSERT INTO hotels (name) VALUES ($1) RETURNING *",
      [body.hotelName]
    )).rows[0];
    const staff = (await client.query(
      `INSERT INTO staff (hotel_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'manager') RETURNING id, hotel_id, name, email, role`,
      [hotel.id, body.name, body.email.toLowerCase(), await bcrypt.hash(body.password, 12)]
    )).rows[0];
    return { hotel, staff };
  });

  res.status(201).json({ ...result, token: signSession(result.staff) });
}));

authRouter.post("/login", asyncHandler(async (req, res) => {
  const body = z.object({
    email: z.string().email(),
    password: z.string().min(1)
  }).parse(req.body);

  const { rows } = await query(
    `SELECT s.*, h.name hotel_name, h.logo_url
       FROM staff s JOIN hotels h ON h.id = s.hotel_id
      WHERE s.email = $1`,
    [body.email.toLowerCase()]
  );
  const validStaff = rows[0] && await bcrypt.compare(body.password, rows[0].password_hash) ? rows[0] : null;
  if (!validStaff) throw new HttpError(401, "Invalid credentials");

  delete validStaff.password_hash;
  res.json({ staff: validStaff, token: signSession(validStaff) });
}));

authRouter.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.hotel_id, s.name, s.email, s.role, s.zone,
            h.name hotel_name, h.logo_url, h.address
       FROM staff s JOIN hotels h ON h.id = s.hotel_id
      WHERE s.id = $1 AND s.hotel_id = $2`,
    [req.user.staffId, req.user.hotelId]
  );
  res.json(rows[0]);
}));
