import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../utils/http.js";

export const adminRouter = Router();

// ─── Admin key auth — NOT JWT, checked against ADMIN_SECRET env var ───────────
function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
adminRouter.use(adminAuth);

// ─── GET /api/admin/overview ──────────────────────────────────────────────────
adminRouter.get("/overview", asyncHandler(async (_req, res) => {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM hotels)                                         AS total_hotels,
      (SELECT COUNT(*)::int FROM guests)                                         AS total_guests,
      (SELECT COUNT(*)::int FROM bookings)                                       AS total_bookings,
      (SELECT COUNT(*)::int FROM bookings WHERE status IN ('upcoming','current')) AS active_bookings,
      (SELECT COUNT(*)::int FROM bookings WHERE DATE(check_in) = CURRENT_DATE)   AS checkins_today,
      (SELECT COUNT(*)::int FROM bookings WHERE DATE(check_out) = CURRENT_DATE
             AND status = 'past')                                                AS checkouts_today,
      (SELECT COUNT(*)::int FROM hotels WHERE created_at > NOW() - INTERVAL '7 days')  AS new_hotels_this_week,
      (SELECT COUNT(*)::int FROM hotels WHERE created_at > NOW() - INTERVAL '30 days') AS new_hotels_this_month,
      (SELECT COUNT(*)::int FROM messages)                                        AS total_messages,
      (SELECT COUNT(*)::int FROM service_requests)                                AS total_service_requests
  `);
  res.json({ ...rows[0], db_uptime: process.uptime() });
}));

// ─── GET /api/admin/hotels ────────────────────────────────────────────────────
adminRouter.get("/hotels", asyncHandler(async (_req, res) => {
  const { rows } = await query(`
    SELECT
      h.id, h.name, h.country, h.created_at, h.onboarding_complete, h.kyc_required,
      (SELECT COUNT(*)::int FROM rooms    r WHERE r.hotel_id = h.id)                    AS room_count,
      (SELECT COUNT(*)::int FROM bookings b WHERE b.hotel_id = h.id)                    AS booking_count,
      (SELECT COUNT(*)::int FROM guests   g WHERE g.hotel_id = h.id)                    AS guest_count,
      (SELECT COUNT(*)::int FROM bookings b WHERE b.hotel_id = h.id AND b.status = 'current') AS active_guest_count,
      (SELECT MAX(b.created_at) FROM bookings b WHERE b.hotel_id = h.id)                AS last_activity
    FROM hotels h
    ORDER BY last_activity DESC NULLS LAST
  `);
  res.json(rows);
}));

// ─── GET /api/admin/activity — last 30 days ───────────────────────────────────
adminRouter.get("/activity", asyncHandler(async (_req, res) => {
  const { rows } = await query(`
    SELECT
      d.day::date                                                                 AS date,
      COALESCE(ci.checkins,    0)::int                                            AS checkins,
      COALESCE(co.checkouts,   0)::int                                            AS checkouts,
      COALESCE(nb.new_bookings,0)::int                                            AS new_bookings,
      COALESCE(nh.new_hotels,  0)::int                                            AS new_hotels,
      COALESCE(ms.messages_sent,0)::int                                           AS messages_sent
    FROM generate_series(
      (CURRENT_DATE - INTERVAL '29 days')::timestamp,
      CURRENT_DATE::timestamp,
      '1 day'::interval
    ) AS d(day)
    LEFT JOIN (
      SELECT DATE(check_in) day, COUNT(*) checkins
      FROM bookings WHERE check_in >= CURRENT_DATE - INTERVAL '30 days' GROUP BY 1
    ) ci ON ci.day = d.day::date
    LEFT JOIN (
      SELECT DATE(check_out) day, COUNT(*) checkouts
      FROM bookings WHERE check_out >= CURRENT_DATE - INTERVAL '30 days' AND status='past' GROUP BY 1
    ) co ON co.day = d.day::date
    LEFT JOIN (
      SELECT DATE(created_at) day, COUNT(*) new_bookings
      FROM bookings WHERE created_at >= CURRENT_DATE - INTERVAL '30 days' GROUP BY 1
    ) nb ON nb.day = d.day::date
    LEFT JOIN (
      SELECT DATE(created_at) day, COUNT(*) new_hotels
      FROM hotels WHERE created_at >= CURRENT_DATE - INTERVAL '30 days' GROUP BY 1
    ) nh ON nh.day = d.day::date
    LEFT JOIN (
      SELECT DATE(created_at) day, COUNT(*) messages_sent
      FROM messages WHERE created_at >= CURRENT_DATE - INTERVAL '30 days' GROUP BY 1
    ) ms ON ms.day = d.day::date
    ORDER BY d.day
  `);
  res.json(rows);
}));

// ─── GET /api/admin/guests — recent 50 guests across all hotels ───────────────
adminRouter.get("/guests", asyncHandler(async (_req, res) => {
  const { rows } = await query(`
    SELECT
      g.name   AS guest_name,
      g.email  AS guest_email,
      h.name   AS hotel_name,
      b.check_in,
      b.check_out,
      b.status,
      b.created_at
    FROM guests g
    JOIN bookings b ON b.guest_id   = g.id
    JOIN hotels  h ON h.id         = g.hotel_id
    ORDER BY b.created_at DESC
    LIMIT 50
  `);
  res.json(rows);
}));
