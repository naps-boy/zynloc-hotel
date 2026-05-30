import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");   // Force IPv4 — Render free tier blocks IPv6 egress
import http from "node:http";
import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
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
import { attachRealtime }        from "./services/realtime.js";
import { startLateCheckoutMonitor } from "./jobs/lateCheckout.js";
import { runMigrations }         from "./db/runMigrations.js";
import { config as cfg }         from "./config.js";
import { pool }                  from "./db/pool.js";

const app    = express();
const server = http.createServer(app);

// CORS — CLIENT_URL may be comma-separated (localhost + ngrok URL)
const allowedOrigins = cfg.clientUrl.split(",").map((s) => s.trim());
const originOption   = allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins;
const corsOptions    = { origin: originOption, credentials: true };

const io = new Server(server, { cors: corsOptions });
attachRealtime(io);

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors(corsOptions));
app.use(compression());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));  // raised for base64 selfie uploads

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Auth endpoints: 20 attempts per 15 min (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many login attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/auth/", authLimiter);

// General API: 500 req per 15 min per IP (handles ~10k concurrent light users)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", apiLimiter);

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
});
