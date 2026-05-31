import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");   // Force IPv4 — Render free tier blocks IPv6 egress
import http from "node:http";
import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { Server } from "socket.io";
import { config } from "./config.js";
import { authRouter }            from "./routes/auth.js";
import { roomsRouter }           from "./routes/rooms.js";
import { bookingsRouter }        from "./routes/bookings.js";
import { facilitiesRouter }      from "./routes/facilities.js";
import { guestsRouter }          from "./routes/guests.js";
import { staffRouter }           from "./routes/staff.js";
import { messagesRouter }        from "./routes/messages.js";
import { notificationsRouter }   from "./routes/notifications.js";
import { analyticsRouter }       from "./routes/analytics.js";
import { settingsRouter }        from "./routes/settings.js";
import { guestRouter }           from "./routes/guest.js";
import { reportsRouter }         from "./routes/reports.js";
import { packagesRouter }        from "./routes/packages.js";
import { navigationRouter }      from "./routes/navigation.js";
import { serviceRequestsRouter } from "./routes/service-requests.js";
import { accessLogRouter }       from "./routes/access-log.js";
import { smtpRouter }            from "./routes/smtp.js";
import { alertsRouter }          from "./routes/alerts.js";
import { adminRouter }           from "./routes/admin.js";
import { attachRealtime }        from "./services/realtime.js";
import { startLateCheckoutMonitor } from "./jobs/lateCheckout.js";
import { runMigrations }         from "./db/runMigrations.js";
import { config as cfg }         from "./config.js";
import { pool }                  from "./db/pool.js";

const app    = express();
const server = http.createServer(app);

// CORS — always allow both the production domains plus whatever CLIENT_URL is set to
const allowedOrigins = [
  "https://veltaforge.com",
  "https://www.veltaforge.com",
  "https://zynloc-hotel.pages.dev",
  ...cfg.clientUrl.split(",").map((s) => s.trim()),
].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i); // deduplicate

const corsOptions = {
  origin: (origin, cb) => {
    // allow server-to-server (no origin) and any listed origin
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key"],
};

const io = new Server(server, { cors: corsOptions });
attachRealtime(io);

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors(corsOptions));
app.use(compression());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));  // raised for base64 selfie uploads

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "zynloc-api", db: "connected", uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ ok: false, service: "zynloc-api", db: "disconnected" });
  }
});


app.use("/api/auth",             authRouter);
app.use("/api/rooms",            roomsRouter);
app.use("/api/bookings",         bookingsRouter);
app.use("/api/guests",           guestsRouter);
app.use("/api/facilities",       facilitiesRouter);
app.use("/api/staff",            staffRouter);
app.use("/api/messages",         messagesRouter);
app.use("/api/notifications",    notificationsRouter);
app.use("/api/analytics",        analyticsRouter);
app.use("/api/settings",         settingsRouter);
app.use("/api/reports",          reportsRouter);
app.use("/api/guest",            guestRouter);
app.use("/api/packages",         packagesRouter);
app.use("/api/navigation",       navigationRouter);
app.use("/api/service-requests", serviceRequestsRouter);
app.use("/api/access-log",       accessLogRouter);
app.use("/api/smtp",             smtpRouter);
app.use("/api/alerts",           alertsRouter);
app.use("/api/admin",            adminRouter);

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  const status  = err.status || 500;
  const details = err.issues?.map((i) => i.message) || undefined;
  if (status >= 500) console.error("[API Error]", err.message, err.stack);
  res.status(status).json({
    error: status >= 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message || "Server error",
    ...(details ? { details } : {}),
  });
});

await runMigrations();

server.listen(cfg.port, () => {
  console.log(`Zynloc API listening on ${cfg.port}`);
  startLateCheckoutMonitor();

  // ── KYC document lifecycle ────────────────────────────────────────────────
  // Runs once per day: marks docs expiring within 30 days, deletes expired ones.
  setInterval(async () => {
    try {
      // Mark docs that expire within 30 days (so UI can warn managers)
      await pool.query(
        `UPDATE guest_documents SET notified_before_delete = true
         WHERE delete_at < now() + INTERVAL '30 days'
           AND notified_before_delete = false`
      );
      // Hard-delete docs whose delete_at has passed
      const { rowCount } = await pool.query(
        "DELETE FROM guest_documents WHERE delete_at < now()"
      );
      if (rowCount > 0) console.log(`[KYC] Auto-deleted ${rowCount} expired document(s)`);
    } catch (err) {
      console.error("[KYC cleanup]", err.message);
    }
  }, 24 * 60 * 60 * 1000).unref();
});
