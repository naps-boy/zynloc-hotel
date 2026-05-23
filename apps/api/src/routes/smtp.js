import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getHotelSmtpConfig, sendTestEmail } from "../services/email.js";
import { asyncHandler, HttpError } from "../utils/http.js";

export const smtpRouter = Router();
smtpRouter.use(requireAuth);

const smtpSchema = z.object({
  label:      z.string().min(1).max(100).default("Default"),
  senderName: z.string().min(1).max(255),
  email:      z.string().email(),
  smtpHost:   z.string().min(1).default("smtp.gmail.com"),
  smtpPort:   z.coerce.number().int().min(1).max(65535).default(587),
  smtpUser:   z.string().min(1),
  smtpPass:   z.string().min(1),
});

// ─── GET /api/smtp — list configs for this hotel ──────────────────────────────
smtpRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, label, sender_name, email, smtp_host, smtp_port, smtp_user,
            is_default, created_at, updated_at
       FROM smtp_configs
      WHERE hotel_id = $1
      ORDER BY is_default DESC, created_at ASC`,
    [req.user.hotelId]
  );
  // Never return smtp_pass in list responses
  res.json(rows);
}));

// ─── POST /api/smtp — create new SMTP config ──────────────────────────────────
smtpRouter.post("/", requireRole("manager"), asyncHandler(async (req, res) => {
  const body = smtpSchema.parse(req.body);

  // Count existing configs — cap at 4 per hotel
  const { rows: existing } = await query(
    "SELECT id FROM smtp_configs WHERE hotel_id = $1",
    [req.user.hotelId]
  );
  if (existing.length >= 4) throw new HttpError(400, "Maximum 4 SMTP configs per hotel");

  // If this is the first config, make it the default automatically
  const makeDefault = existing.length === 0;

  const { rows } = await query(
    `INSERT INTO smtp_configs
       (hotel_id, label, sender_name, email, smtp_host, smtp_port, smtp_user, smtp_pass, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, label, sender_name, email, smtp_host, smtp_port, smtp_user, is_default, created_at`,
    [
      req.user.hotelId,
      body.label, body.senderName, body.email,
      body.smtpHost, body.smtpPort, body.smtpUser, body.smtpPass,
      makeDefault,
    ]
  );
  res.status(201).json(rows[0]);
}));

// ─── PUT /api/smtp/:id — update SMTP config ───────────────────────────────────
smtpRouter.put("/:id", requireRole("manager"), asyncHandler(async (req, res) => {
  const body = smtpSchema.partial().parse(req.body);

  // Verify ownership
  const existing = (await query(
    "SELECT id FROM smtp_configs WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  )).rows[0];
  if (!existing) throw new HttpError(404, "SMTP config not found");

  const { rows } = await query(
    `UPDATE smtp_configs SET
       label       = COALESCE($3, label),
       sender_name = COALESCE($4, sender_name),
       email       = COALESCE($5, email),
       smtp_host   = COALESCE($6, smtp_host),
       smtp_port   = COALESCE($7, smtp_port),
       smtp_user   = COALESCE($8, smtp_user),
       smtp_pass   = COALESCE($9, smtp_pass),
       updated_at  = now()
     WHERE id = $1 AND hotel_id = $2
     RETURNING id, label, sender_name, email, smtp_host, smtp_port, smtp_user, is_default, updated_at`,
    [
      req.params.id, req.user.hotelId,
      body.label ?? null,
      body.senderName ?? null,
      body.email ?? null,
      body.smtpHost ?? null,
      body.smtpPort ?? null,
      body.smtpUser ?? null,
      body.smtpPass ?? null,
    ]
  );
  res.json(rows[0]);
}));

// ─── DELETE /api/smtp/:id — remove SMTP config ────────────────────────────────
smtpRouter.delete("/:id", requireRole("manager"), asyncHandler(async (req, res) => {
  const existing = (await query(
    "SELECT id, is_default FROM smtp_configs WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  )).rows[0];
  if (!existing) throw new HttpError(404, "SMTP config not found");

  await query("DELETE FROM smtp_configs WHERE id = $1", [req.params.id]);

  // If deleted config was the default, promote the next oldest to default
  if (existing.is_default) {
    await query(
      `UPDATE smtp_configs SET is_default = TRUE
         WHERE hotel_id = $1
           AND id = (SELECT id FROM smtp_configs WHERE hotel_id = $1 ORDER BY created_at LIMIT 1)`,
      [req.user.hotelId]
    );
  }

  res.json({ ok: true });
}));

// ─── POST /api/smtp/:id/set-default — make this config the default ────────────
smtpRouter.post("/:id/set-default", requireRole("manager"), asyncHandler(async (req, res) => {
  const existing = (await query(
    "SELECT id FROM smtp_configs WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  )).rows[0];
  if (!existing) throw new HttpError(404, "SMTP config not found");

  // Clear current default, then set new one
  await query("UPDATE smtp_configs SET is_default = FALSE WHERE hotel_id = $1", [req.user.hotelId]);
  await query("UPDATE smtp_configs SET is_default = TRUE  WHERE id = $1", [req.params.id]);

  res.json({ ok: true });
}));

// ─── POST /api/smtp/:id/test — send a test email ─────────────────────────────
smtpRouter.post("/:id/test", requireRole("manager"), asyncHandler(async (req, res) => {
  const { to } = z.object({ to: z.string().email() }).parse(req.body);

  const { rows } = await query(
    "SELECT * FROM smtp_configs WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  );
  if (!rows.length) throw new HttpError(404, "SMTP config not found");

  const result = await sendTestEmail(rows[0], to);
  if (!result.ok) throw new HttpError(502, `SMTP error: ${result.error}`);
  res.json({ ok: true, messageId: result.messageId });
}));
