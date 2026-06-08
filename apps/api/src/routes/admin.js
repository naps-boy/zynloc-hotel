import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../utils/http.js";

export const adminRouter = Router();

// ─── Admin key auth — NOT JWT, checked against ADMIN_SECRET env var ───────────
const EFFECTIVE_ADMIN_SECRET = process.env.ADMIN_SECRET || "ZynlocAdmin2026!";

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== EFFECTIVE_ADMIN_SECRET) {
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
  // Aggregate new bookings per day for the last 30 days
  const bookingRows = await query(`
    SELECT DATE(created_at)::text AS date, COUNT(*)::int AS new_bookings
    FROM bookings
    WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY 1 ORDER BY 1
  `);

  // Check-ins per day (using check_in date as proxy)
  const checkinRows = await query(`
    SELECT DATE(check_in)::text AS date, COUNT(*)::int AS checkins
    FROM bookings
    WHERE check_in >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY 1 ORDER BY 1
  `);

  // New hotels per day
  const hotelRows = await query(`
    SELECT DATE(created_at)::text AS date, COUNT(*)::int AS new_hotels
    FROM hotels
    WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY 1 ORDER BY 1
  `);

  // Messages per day
  const msgRows = await query(`
    SELECT DATE(created_at)::text AS date, COUNT(*)::int AS messages_sent
    FROM messages
    WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY 1 ORDER BY 1
  `).catch(() => ({ rows: [] }));

  // Merge by date
  const dateMap = {};
  const addRow = (rows, key) => {
    for (const r of rows) {
      if (!dateMap[r.date]) dateMap[r.date] = { date: r.date, new_bookings: 0, checkins: 0, new_hotels: 0, messages_sent: 0 };
      dateMap[r.date][key] = r[key];
    }
  };
  addRow(bookingRows.rows, "new_bookings");
  addRow(checkinRows.rows, "checkins");
  addRow(hotelRows.rows, "new_hotels");
  addRow(msgRows.rows, "messages_sent");

  res.json(Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date)));
}));


// ─── GET /api/admin/test-seam — temporary diagnostic ─────────────────────────
adminRouter.get("/test-seam", asyncHandler(async (_req, res) => {
  const key = process.env.SEAM_API_KEY;
  if (!key || key === "PLACEHOLDER_ADD_YOUR_SEAM_KEY_HERE") {
    return res.json({ seam_key: false, message: "No Seam API key configured" });
  }
  try {
    const result = await fetch("https://connect.getseam.com/devices/list", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await result.json().catch(() => ({}));
    if (result.ok) {
      res.json({ seam_key: true, key_valid: true, device_count: data.devices?.length || 0, message: "Seam API key is valid and working" });
    } else {
      res.json({ seam_key: true, key_valid: false, error: data.error?.message || data.message || "Invalid key", message: "Seam API key exists but is not valid" });
    }
  } catch (err) {
    res.json({ seam_key: false, error: err.message });
  }
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
