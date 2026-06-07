import { Router }      from "express";
import { query }       from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/http.js";

export const activityLogRouter = Router();
activityLogRouter.use(requireAuth);

// ── GET /api/activity-log ─────────────────────────────────────────────────────
activityLogRouter.get("/", asyncHandler(async (req, res) => {
  const {
    resource_type,
    result,
    from,
    to,
    search,
    limit  = "50",
    page   = "1",
  } = req.query;

  const params  = [req.user.hotelId];
  const clauses = ["al.hotel_id = $1"];

  if (resource_type && resource_type !== "all") {
    params.push(resource_type);
    clauses.push(`al.resource_type = $${params.length}`);
  }
  if (result && result !== "all") {
    params.push(result);
    clauses.push(`al.result = $${params.length}`);
  }
  if (from) {
    params.push(from);
    clauses.push(`al.accessed_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    clauses.push(`al.accessed_at <= $${params.length}::date + INTERVAL '1 day'`);
  }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(al.actor_name ILIKE $${params.length} OR al.resource_name ILIKE $${params.length})`);
  }

  const where  = "WHERE " + clauses.join(" AND ");
  const lim    = Math.min(Number(limit)  || 50, 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * lim;

  const { rows } = await query(
    `SELECT al.*,
            b.id booking_id_ref
       FROM access_activity_log al
       LEFT JOIN bookings b ON b.id = al.booking_id
      ${where}
      ORDER BY al.accessed_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, lim, offset]
  );

  // Total count for pagination
  const { rows: countRows } = await query(
    `SELECT COUNT(*) total FROM access_activity_log al ${where}`,
    params
  );

  res.json({
    rows,
    total: Number(countRows[0]?.total || 0),
    page: Number(page),
    limit: lim,
  });
}));

// ── GET /api/activity-log/export ──────────────────────────────────────────────
activityLogRouter.get("/export", asyncHandler(async (req, res) => {
  const { resource_type, result, from, to, search } = req.query;

  const params  = [req.user.hotelId];
  const clauses = ["al.hotel_id = $1"];

  if (resource_type && resource_type !== "all") {
    params.push(resource_type);
    clauses.push(`al.resource_type = $${params.length}`);
  }
  if (result && result !== "all") {
    params.push(result);
    clauses.push(`al.result = $${params.length}`);
  }
  if (from) {
    params.push(from);
    clauses.push(`al.accessed_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    clauses.push(`al.accessed_at <= $${params.length}::date + INTERVAL '1 day'`);
  }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(al.actor_name ILIKE $${params.length} OR al.resource_name ILIKE $${params.length})`);
  }

  const where = "WHERE " + clauses.join(" AND ");
  const { rows } = await query(
    `SELECT al.accessed_at, al.actor_name, al.actor_type, al.resource_type,
            al.resource_name, al.action, al.result
       FROM access_activity_log al
      ${where}
      ORDER BY al.accessed_at DESC
      LIMIT 5000`,
    params
  );

  const header = "Time,Actor,Actor Type,Resource Type,Resource,Action,Result\n";
  const csv = header + rows.map(r =>
    [
      new Date(r.accessed_at).toISOString(),
      `"${(r.actor_name    || "").replace(/"/g, '""')}"`,
      r.actor_type    || "",
      r.resource_type || "",
      `"${(r.resource_name || "").replace(/"/g, '""')}"`,
      r.action || "",
      r.result || "",
    ].join(",")
  ).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="activity-log-${Date.now()}.csv"`);
  res.send(csv);
}));
