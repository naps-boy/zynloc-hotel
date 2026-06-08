import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAuth, signSession } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";
import { config } from "../config.js";
import { sendPasswordResetEmail } from "../services/email.js";


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
      WHERE s.email = $1
      ORDER BY s.created_at DESC`,
    [body.email.toLowerCase()]
  );
  // When a manager has registered more than one hotel with the same email,
  // rows[0] is the most-recently-created staff/hotel pair (ORDER BY created_at DESC).
  // bcrypt.compare is run only on rows[0] — same password hash is set on every staff
  // record for a given user, so whichever row wins, the hash check is correct.
  const validStaff = rows[0] && await bcrypt.compare(body.password, rows[0].password_hash) ? rows[0] : null;
  if (!validStaff) throw new HttpError(401, "Invalid credentials");

  delete validStaff.password_hash;
  res.json({ staff: validStaff, token: signSession(validStaff) });
}));

// POST /api/auth/forgot-password — send reset link (always returns 200 to avoid email enumeration)
authRouter.post("/forgot-password", asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const lookupEmail = email.toLowerCase();
  console.log(`[ForgotPw] Request received for: ${lookupEmail}`);

  // ORDER BY created_at DESC — consistent with login: most-recently-created hotel wins.
  // We generate a single reset token for rows[0] (the active hotel) and send the email,
  // but we must reset the password on ALL staff records sharing this email so that
  // whichever record login picks up, the new password works.
  const { rows } = await query(
    "SELECT id, hotel_id, name, email FROM staff WHERE email = $1 ORDER BY created_at DESC",
    [lookupEmail]
  );
  console.log(`[ForgotPw] Staff lookup — found: ${rows.length}${rows.length ? ` (primary hotel_id=${rows[0].hotel_id})` : ""}`);

  if (rows.length) {
    const staff = rows[0]; // most-recently-created hotel — same one login uses
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await query(
      "INSERT INTO password_reset_tokens (staff_id, token, expires_at) VALUES ($1, $2, $3)",
      [staff.id, token, expiresAt]
    );
    console.log(`[ForgotPw] Token saved for staff id=${staff.id}. Sending reset email to ${staff.email}`);
    const resetLink = `${config.clientUrl}/reset-password?token=${token}`;
    const messageId = await sendPasswordResetEmail({ staffEmail: staff.email, staffName: staff.name, hotelId: staff.hotel_id, resetLink });
    console.log(`[ForgotPw] sendPasswordResetEmail returned — messageId=${messageId} for ${staff.email}`);
  } else {
    console.log(`[ForgotPw] No staff account found for: ${lookupEmail} — no email sent`);
  }
  res.json({ ok: true });
}));

// POST /api/auth/reset-password — validate token and set new password
authRouter.post("/reset-password", asyncHandler(async (req, res) => {
  const { token, password } = z.object({ token: z.string(), password: z.string().min(8) }).parse(req.body);
  const { rows } = await query(
    `SELECT prt.id, prt.staff_id FROM password_reset_tokens prt
      WHERE prt.token = $1 AND prt.used_at IS NULL AND prt.expires_at > NOW()`,
    [token]
  );
  if (!rows.length) throw new HttpError(400, "Reset link is invalid or has expired");
  const { id: tokenId, staff_id } = rows[0];
  const hash = await bcrypt.hash(password, 12);

  // Update the staff record that owns the token
  await query("UPDATE staff SET password_hash = $1 WHERE id = $2", [hash, staff_id]);

  // Also update every other staff record sharing the same email so that
  // multi-hotel users (same email, multiple hotels) can log in after a reset
  // regardless of which hotel the login ORDER BY picks up.
  const { rows: staffRows } = await query("SELECT email FROM staff WHERE id = $1", [staff_id]);
  if (staffRows[0]) {
    await query(
      "UPDATE staff SET password_hash = $1 WHERE email = $2 AND id <> $3",
      [hash, staffRows[0].email, staff_id]
    );
  }

  await query("UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1", [tokenId]);
  res.json({ ok: true });
}));

authRouter.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.hotel_id, s.name, s.email, s.role, s.zone,
            h.name hotel_name, h.logo_url, h.address
       FROM staff s JOIN hotels h ON h.id = s.hotel_id
      WHERE s.id = $1 AND s.hotel_id = $2`,
    [req.user.staffId, req.user.hotelId]
  );
  if (!rows[0]) return res.status(401).json({ error: "Account not found" });
  res.json(rows[0]);
}));
