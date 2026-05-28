import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/http.js";

export const alertsRouter = Router();
alertsRouter.use(requireAuth);

// GET /api/alerts — returns { unresolved: [], resolved: [] }
// Joins qr_codes to include qr_token for arrival alerts (used for check-in button)
alertsRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*,
            qc.token AS qr_token
       FROM alerts a
       LEFT JOIN qr_codes qc
              ON qc.booking_id = a.booking_id
             AND qc.revoked = FALSE
             AND qc.expires_at > NOW()
      WHERE a.hotel_id = $1
      ORDER BY a.created_at DESC
      LIMIT 300`,
    [req.user.hotelId]
  );
  res.json({
    unresolved: rows.filter(r => !r.resolved),
    resolved:   rows.filter(r => r.resolved),
  });
}));

// POST /api/alerts/:id/resolve
alertsRouter.post("/:id/resolve", asyncHandler(async (req, res) => {
  await query(
    `UPDATE alerts SET resolved = TRUE, resolved_at = NOW()
      WHERE id = $1 AND hotel_id = $2`,
    [req.params.id, req.user.hotelId]
  );
  res.json({ ok: true });
}));

// POST /api/alerts/:id/unresolve
alertsRouter.post("/:id/unresolve", asyncHandler(async (req, res) => {
  await query(
    `UPDATE alerts SET resolved = FALSE, resolved_at = NULL
      WHERE id = $1 AND hotel_id = $2`,
    [req.params.id, req.user.hotelId]
  );
  res.json({ ok: true });
}));
