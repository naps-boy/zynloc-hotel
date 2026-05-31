import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../utils/http.js";

export const adminRouter = Router();

// ─── Admin key auth — NOT JWT, checked against ADMIN_SECRET env var ───────────
// Falls back to the default key if ADMIN_SECRET env var is not set.
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

// ─── GET /api/admin/protect-accounts/discover — TEMP: find top 4 active hotels
adminRouter.get("/protect-accounts/discover", asyncHandler(async (_req, res) => {
  const { rows } = await query(`
    SELECT
      h.id,
      h.name,
      h.created_at,
      s.email AS manager_email,
      s.name  AS manager_name,
      COUNT(DISTINCT b.id)::int AS total_bookings,
      COUNT(DISTINCT g.id)::int AS total_guests,
      MAX(b.created_at)         AS last_booking,
      MAX(s.created_at)         AS last_staff_activity
    FROM hotels h
    LEFT JOIN staff    s ON s.hotel_id = h.id AND s.role = 'manager'
    LEFT JOIN bookings b ON b.hotel_id = h.id
    LEFT JOIN guests   g ON g.hotel_id = h.id
    GROUP BY h.id, h.name, h.created_at, s.email, s.name
    ORDER BY MAX(b.created_at) DESC NULLS LAST, h.created_at DESC
    LIMIT 4
  `);
  res.json(rows);
}));

// ─── GET /api/admin/protect-accounts/detail/:hotelId — TEMP: full detail ──────
adminRouter.get("/protect-accounts/detail/:hotelId", asyncHandler(async (req, res) => {
  const hid = req.params.hotelId;
  const [bookings, messages, notifications, waypoints] = await Promise.all([
    query(`SELECT b.id, g.name AS guest_name, g.email AS guest_email,
                  b.status, b.check_in, b.check_out, b.created_at
           FROM bookings b JOIN guests g ON g.id = b.guest_id
           WHERE b.hotel_id = $1 ORDER BY b.created_at DESC`, [hid]),
    query(`SELECT COUNT(*)::int AS message_count FROM messages WHERE hotel_id = $1`, [hid]),
    query(`SELECT COUNT(*)::int AS notification_count FROM notifications WHERE hotel_id = $1`, [hid]),
    query(`SELECT COUNT(*)::int AS waypoint_count FROM navigation_waypoints WHERE hotel_id = $1`, [hid])
      .catch(() => ({ rows: [{ waypoint_count: 0 }] })),
  ]);
  res.json({
    hotel_id:           hid,
    bookings:           bookings.rows,
    message_count:      messages.rows[0].message_count,
    notification_count: notifications.rows[0].notification_count,
    waypoint_count:     waypoints.rows[0].waypoint_count,
  });
}));

// ─── POST /api/admin/protect-accounts/run — TEMP: create table, insert, reset pw
adminRouter.post("/protect-accounts/run", asyncHandler(async (req, res) => {
  const { hotel_ids, password_hash } = req.body;
  if (!Array.isArray(hotel_ids) || hotel_ids.length === 0) {
    return res.status(400).json({ error: "hotel_ids required" });
  }
  if (!password_hash) return res.status(400).json({ error: "password_hash required" });

  // 1. Create protected_accounts table
  await query(`
    CREATE TABLE IF NOT EXISTS protected_accounts (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hotel_id     UUID NOT NULL REFERENCES hotels(id),
      reason       VARCHAR(255) DEFAULT 'test account - preserve all data',
      protected_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // 2. Insert hotel IDs
  const inserts = [];
  for (const hid of hotel_ids) {
    const r = await query(
      `INSERT INTO protected_accounts (hotel_id, reason)
       VALUES ($1, 'test account - preserve all data - do not delete')
       ON CONFLICT DO NOTHING RETURNING id, hotel_id`,
      [hid]
    );
    inserts.push(r.rows[0] || { hotel_id: hid, note: "already existed or no conflict target" });
  }

  // 3. Reset manager passwords
  const pwUpdate = await query(
    `UPDATE staff SET password_hash = $1
     WHERE hotel_id = ANY($2::uuid[]) AND role = 'manager'
     RETURNING id, hotel_id, email, name`,
    [password_hash, hotel_ids]
  );

  // 4. Verify protected_accounts rows
  const verify = await query(
    `SELECT pa.hotel_id, h.name, pa.reason, pa.protected_at
     FROM protected_accounts pa JOIN hotels h ON h.id = pa.hotel_id
     WHERE pa.hotel_id = ANY($1::uuid[])`,
    [hotel_ids]
  );

  res.json({
    table_created:     true,
    inserts,
    passwords_updated: pwUpdate.rows,
    verification:      verify.rows,
  });
}));
