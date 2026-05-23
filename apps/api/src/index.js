import http from "node:http";
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
import { attachRealtime }        from "./services/realtime.js";
import { startLateCheckoutMonitor } from "./jobs/lateCheckout.js";
import { runMigrations }         from "./db/runMigrations.js";
import { config as cfg }         from "./config.js";

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
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));  // raised for base64 selfie uploads

app.get("/health", (_req, res) => res.json({ ok: true, service: "zynloc-api" }));

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

// ── Test-email endpoint (GET /api/test-email?to=addr) ────────────────────────
app.get("/api/test-email", async (req, res) => {
  const to  = req.query.to || "test@example.com";
  const key = cfg.resendApiKey;
  console.log(`[test-email] RESEND_API_KEY present=${!!key} prefix=${key ? key.slice(0,8)+"…" : "none"}`);
  if (!key) {
    return res.json({ error: "RESEND_API_KEY not set", configuredFrom: cfg.mailFrom });
  }
  const payload = {
    from: cfg.mailFrom,
    to:   [to],
    subject: "Zynloc test email",
    html: "<p>Test email from Zynloc Hotel API. If you received this, Resend is working correctly.</p>",
  };
  console.log(`[test-email] Sending to=${to} from=${cfg.mailFrom}`);
  const resp = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });
  const bodyText = await resp.text();
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
  console.log(`[test-email] Resend responded ${resp.status}: ${bodyText}`);
  res.json({ resendStatus: resp.status, resendBody: parsed, sentTo: to, sentFrom: cfg.mailFrom, apiKeyPrefix: key.slice(0,8)+"…" });
});

app.use((error, _req, res, _next) => {
  const status  = error.status || 500;
  const details = error.issues?.map((i) => i.message) || undefined;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message || "Server error", details });
});

await runMigrations();

server.listen(cfg.port, () => {
  console.log(`Zynloc API listening on ${cfg.port}`);
  startLateCheckoutMonitor();
});
