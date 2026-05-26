import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAuth, signSession } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";
import { config } from "../config.js";
import { sendPasswordResetEmail } from "../services/email.js";

// Auto-provision a default Brevo SMTP config for a newly registered hotel.
// Runs after the transaction so a failure here doesn't roll back hotel creation.
async function provisionDefaultSmtp(hotelId) {
  if (!config.brevoApiKey) return; // no platform key — skip silently
  try {
    await query(
      `INSERT INTO smtp_configs
         (hotel_id, provider, label, sender_name, email, smtp_pass, is_default)
       VALUES ($1, 'brevo', 'Default (Brevo)', $2, $3, $4, TRUE)
       ON CONFLICT DO NOTHING`,
      [hotelId, config.brevoSenderName, config.brevoSenderEmail, config.brevoApiKey]
    );
    console.log(`[Auth] Provisioned default Brevo SMTP config for hotel ${hotelId}`);
  } catch (err) {
    console.warn(`[Auth] Failed to provision SMTP config for hotel ${hotelId}:`, err.message);
  }
}

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

  // Provision default SMTP config for the new hotel (non-blocking — doesn't fail registration)
  await provisionDefaultSmtp(result.hotel.id);

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

// POST /api/auth/forgot-password — send reset link (always returns 200 to avoid email enumeration)
authRouter.post("/forgot-password", asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const lookupEmail = email.toLowerCase();
  console.log(`[ForgotPw] Request received for: ${lookupEmail}`);

  const { rows } = await query("SELECT id, hotel_id, name, email FROM staff WHERE email = $1", [lookupEmail]);
  console.log(`[ForgotPw] Staff lookup — found: ${rows.length > 0}${rows.length ? ` (hotel_id=${rows[0].hotel_id})` : ""}`);

  if (rows.length) {
    const staff = rows[0];
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await query(
      "INSERT INTO password_reset_tokens (staff_id, token, expires_at) VALUES ($1, $2, $3)",
      [staff.id, token, expiresAt]
    );
    console.log(`[ForgotPw] Token saved. Sending reset email to ${staff.email}`);
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
  await query("UPDATE staff SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(password, 12), staff_id]);
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
  res.json(rows[0]);
}));
