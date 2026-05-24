import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getHotelSmtpConfig, sendTestEmail } from "../services/email.js";
import { asyncHandler, HttpError } from "../utils/http.js";

export const smtpRouter = Router();
smtpRouter.use(requireAuth);

// Provider-aware schema — brevo/gmail only need email + smtp_pass (API key / App Password)
const smtpSchema = z.object({
  provider:   z.enum(["brevo", "gmail", "custom"]).default("brevo"),
  label:      z.string().min(1).max(100).default("Default"),
  senderName: z.string().min(1).max(255),
  email:      z.string().email(),
  smtpPass:   z.string().min(1),
  // SMTP-only — required when provider === 'custom'
  smtpHost:   z.string().optional().nullable(),
  smtpPort:   z.coerce.number().int().min(1).max(65535).optional().nullable(),
  smtpUser:   z.string().optional().nullable(),
}).refine(
  d => d.provider !== "custom" || (d.smtpHost && d.smtpPort && d.smtpUser),
  { message: "smtpHost, smtpPort and smtpUser are required for custom SMTP" }
);

// SELECT columns exposed to the client (never smtp_pass)
const SELECT_COLS = `id, label, sender_name, email,
  smtp_host, smtp_port, smtp_user, provider,
  is_default, created_at, updated_at`;

// ─── GET /api/smtp ─────────────────────────────────────────────────────────────
smtpRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT ${SELECT_COLS} FROM smtp_configs
      WHERE hotel_id = $1 ORDER BY is_default DESC, created_at ASC`,
    [req.user.hotelId]
  );
  res.json(rows);
}));

// ─── POST /api/smtp ────────────────────────────────────────────────────────────
smtpRouter.post("/", requireRole("manager"), asyncHandler(async (req, res) => {
  const body = smtpSchema.parse(req.body);

  const { rows: existing } = await query(
    "SELECT id FROM smtp_configs WHERE hotel_id = $1", [req.user.hotelId]
  );
  if (existing.length >= 4) throw new HttpError(400, "Maximum 4 email configs per hotel");

  const makeDefault = existing.length === 0;

  // For gmail provider: smtp_user = email address (same field)
  const smtpUser = body.provider === "gmail"
    ? body.email
    : (body.smtpUser || null);

  const { rows } = await query(
    `INSERT INTO smtp_configs
       (hotel_id, label, sender_name, email, smtp_host, smtp_port,
        smtp_user, smtp_pass, is_default, provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${SELECT_COLS}`,
    [
      req.user.hotelId,
      body.label, body.senderName, body.email,
      body.smtpHost || null,
      body.smtpPort || null,
      smtpUser,
      body.smtpPass,
      makeDefault,
      body.provider,
    ]
  );
  res.status(201).json(rows[0]);
}));

// ─── PUT /api/smtp/:id ─────────────────────────────────────────────────────────
smtpRouter.put("/:id", requireRole("manager"), asyncHandler(async (req, res) => {
  const body = smtpSchema.partial().parse(req.body);

  const existing = (await query(
    "SELECT id FROM smtp_configs WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  )).rows[0];
  if (!existing) throw new HttpError(404, "Email config not found");

  const smtpUser = body.provider === "gmail"
    ? (body.email ?? null)
    : (body.smtpUser ?? null);

  const { rows } = await query(
    `UPDATE smtp_configs SET
       label       = COALESCE($3,  label),
       sender_name = COALESCE($4,  sender_name),
       email       = COALESCE($5,  email),
       smtp_host   = COALESCE($6,  smtp_host),
       smtp_port   = COALESCE($7,  smtp_port),
       smtp_user   = COALESCE($8,  smtp_user),
       smtp_pass   = COALESCE($9,  smtp_pass),
       provider    = COALESCE($10, provider),
       updated_at  = now()
     WHERE id = $1 AND hotel_id = $2
     RETURNING ${SELECT_COLS}`,
    [
      req.params.id, req.user.hotelId,
      body.label      ?? null,
      body.senderName ?? null,
      body.email      ?? null,
      body.smtpHost   ?? null,
      body.smtpPort   ?? null,
      smtpUser,
      body.smtpPass   ?? null,
      body.provider   ?? null,
    ]
  );
  res.json(rows[0]);
}));

// ─── DELETE /api/smtp/:id ──────────────────────────────────────────────────────
smtpRouter.delete("/:id", requireRole("manager"), asyncHandler(async (req, res) => {
  const existing = (await query(
    "SELECT id, is_default FROM smtp_configs WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  )).rows[0];
  if (!existing) throw new HttpError(404, "Email config not found");

  await query("DELETE FROM smtp_configs WHERE id = $1", [req.params.id]);

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

// ─── POST /api/smtp/:id/set-default ───────────────────────────────────────────
smtpRouter.post("/:id/set-default", requireRole("manager"), asyncHandler(async (req, res) => {
  const existing = (await query(
    "SELECT id FROM smtp_configs WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  )).rows[0];
  if (!existing) throw new HttpError(404, "Email config not found");

  await query("UPDATE smtp_configs SET is_default = FALSE WHERE hotel_id = $1", [req.user.hotelId]);
  await query("UPDATE smtp_configs SET is_default = TRUE  WHERE id = $1",       [req.params.id]);
  res.json({ ok: true });
}));

// ─── POST /api/smtp/:id/test ───────────────────────────────────────────────────
smtpRouter.post("/:id/test", requireRole("manager"), asyncHandler(async (req, res) => {
  const { to } = z.object({ to: z.string().email() }).parse(req.body);

  const { rows } = await query(
    "SELECT * FROM smtp_configs WHERE id = $1 AND hotel_id = $2",
    [req.params.id, req.user.hotelId]
  );
  if (!rows.length) throw new HttpError(404, "Email config not found");

  const result = await sendTestEmail(rows[0], to);
  if (!result.ok) throw new HttpError(502, `Email error: ${result.error}`);
  res.json({ ok: true, messageId: result.messageId });
}));
