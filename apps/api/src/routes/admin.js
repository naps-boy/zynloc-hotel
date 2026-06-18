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


// ─── GET /api/admin/export-table/:name (TEMP — migration use only) ───────────
adminRouter.get("/export-table/:name", asyncHandler(async (req, res) => {
  const table = req.params.name.replace(/[^a-z_]/g, "");
  try {
    const { rows } = await query(`SELECT * FROM "${table}"`);
    res.json({ table, count: rows.length, rows });
  } catch (err) {
    res.json({ table, count: 0, rows: [], error: err.message });
  }
}));

// ─── POST /api/admin/migrate-to-supabase (TEMP — remove after migration) ─────
// Runs from inside Render (which has proper Supabase connectivity).
// Body: { supabaseUrl: "postgresql://..." }
// Steps: 1) connect to Supabase  2) run all migrations  3) import data  4) verify
adminRouter.post("/migrate-to-supabase", asyncHandler(async (req, res) => {
  const { supabaseUrl } = req.body;
  if (!supabaseUrl) return res.status(400).json({ error: "supabaseUrl required in body" });

  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  const { Pool: PgPool } = require("pg");
  const fs = await import("fs/promises");
  const path = await import("path");
  const { fileURLToPath } = await import("url");

  const log = [];
  const step = (msg) => { log.push(msg); console.log("[migrate]", msg); };

  // ── 1. Connect to Supabase ───────────────────────────────────────────────
  const sbPool = new PgPool({
    connectionString: supabaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 20000,
  });

  try {
    await sbPool.query("SELECT 1");
    step("✓ Connected to Supabase");
  } catch (err) {
    return res.status(500).json({ error: "Cannot connect to Supabase: " + err.message, log });
  }

  // ── 2. Run all migrations ────────────────────────────────────────────────
  try {
    await sbPool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    const applied = new Set(
      (await sbPool.query("SELECT id FROM schema_migrations")).rows.map(r => r.id)
    );

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrDir = path.join(__dirname, "../db/migrations");
    const files = (await fs.readdir(migrDir)).filter(f => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) { step(`  skip ${file} (already applied)`); continue; }
      const sql = await fs.readFile(path.join(migrDir, file), "utf8");
      const client = await sbPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
        await client.query("COMMIT");
        step(`  ✓ Applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        step(`  ✗ ${file} failed: ${err.message.slice(0, 120)}`);
        // Continue — some migrations may conflict on partially-set-up schema
      } finally {
        client.release();
      }
    }
    step("✓ Migrations complete");
  } catch (err) {
    return res.status(500).json({ error: "Migration failed: " + err.message, log });
  }

  // ── 3. Import data ────────────────────────────────────────────────────────
  const TABLE_ORDER = [
    "hotels","staff","rooms","guests","bookings",
    "packages","facilities","package_facilities","facility_access",
    "qr_codes","qr_scans","tasks","messages",
    "notifications","service_requests","alerts","settings",
    "guest_documents","access_activity_log","email_integrations",
    "access_providers","room_devices","access_credentials",
  ];

  try {
    const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
    const dataFile = path.join(__dirname2, "../db/migration_data.json");
    const exportData = JSON.parse(await fs.readFile(dataFile, "utf8"));

    const inserted = {};
    const skipped = {};

    for (const table of TABLE_ORDER) {
      const rows = exportData.tables[table];
      if (!rows || rows.length === 0) { skipped[table] = 0; continue; }

      // Check if table exists in Supabase
      const { rows: exists } = await sbPool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
        [table]
      );
      if (!exists.length) { skipped[table] = `table not found`; continue; }

      // Check existing row count
      const { rows: countRows } = await sbPool.query(`SELECT COUNT(*)::int AS c FROM "${table}"`);
      if (countRows[0].c > 0) {
        skipped[table] = `${countRows[0].c} rows already present`;
        step(`  ↩ ${table}: ${countRows[0].c} rows already exist — skipping`);
        continue;
      }

      const cols = Object.keys(rows[0]);
      const colList = cols.map(c => `"${c}"`).join(", ");
      let count = 0;
      const BATCH = 50;

      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const values = [];
        const placeholders = batch.map((row, bi) =>
          "(" + cols.map((col, ci) => { values.push(row[col]); return `$${bi * cols.length + ci + 1}`; }).join(", ") + ")"
        ).join(", ");
        await sbPool.query(
          `INSERT INTO "${table}" (${colList}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
          values
        );
        count += batch.length;
      }
      inserted[table] = count;
      step(`  ✓ ${table}: ${count} rows inserted`);
    }
    step("✓ Data import complete");

    // ── 4. Verify counts ───────────────────────────────────────────────────
    const verify = {};
    for (const table of ["hotels","staff","rooms","guests","bookings","packages","facilities","messages"]) {
      try {
        const { rows: [{ c }] } = await sbPool.query(`SELECT COUNT(*)::int AS c FROM "${table}"`);
        verify[table] = c;
      } catch { verify[table] = "error"; }
    }

    await sbPool.end();
    step("✓ Migration complete");

    res.json({ ok: true, log, inserted, skipped, verify });
  } catch (err) {
    await sbPool.end().catch(() => {});
    res.status(500).json({ error: "Import failed: " + err.message, log });
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
