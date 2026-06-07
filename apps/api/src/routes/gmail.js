import { Router }     from "express";
import { query }      from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";
import { createBookingFromDraft }  from "../services/bookings.js";
import { config }     from "../config.js";

export const gmailRouter = Router();

// ── OAuth helpers (direct fetch — no googleapis library) ──────────────────────

function buildAuthUrl(hotelId) {
  return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id:     config.googleClientId,
    redirect_uri:  config.googleRedirectUri,
    response_type: "code",
    scope:         "https://www.googleapis.com/auth/gmail.readonly",
    access_type:   "offline",
    prompt:        "consent",
    state:         hotelId,
  }).toString();
}

async function exchangeCode(code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      code,
      client_id:     config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri:  config.googleRedirectUri,
      grant_type:    "authorization_code",
    }),
  });
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     config.googleClientId,
      client_secret: config.googleClientSecret,
      grant_type:    "refresh_token",
    }),
  });
  return res.json();
}

async function getGmailProfile(accessToken) {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.json();
}

async function listMessages(accessToken, queryStr, maxResults = 20) {
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?" + new URLSearchParams({
      q:          queryStr,
      maxResults: String(maxResults),
    }),
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.json();
}

async function getMessage(accessToken, messageId) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.json();
}

// Get a valid access token — refresh if expired or close to expiry
async function getValidToken(int, hotelId) {
  const expiresAt = int.token_expiry ? new Date(int.token_expiry).getTime() : 0;
  const needsRefresh = !int.access_token || expiresAt < Date.now() + 60_000;

  if (!needsRefresh) return int.access_token;

  if (!int.refresh_token) throw new HttpError(400, "Gmail token expired and no refresh token stored — please reconnect Gmail.");

  const tokens = await refreshAccessToken(int.refresh_token);
  if (!tokens.access_token) throw new HttpError(400, "Failed to refresh Gmail access token — please reconnect Gmail.");

  await query(
    `UPDATE email_integrations
        SET access_token = $1, token_expiry = $2, updated_at = now()
      WHERE hotel_id = $3 AND provider = 'gmail'`,
    [tokens.access_token, tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null, hotelId]
  ).catch(err => console.warn("[gmail token save]", err.message));

  return tokens.access_token;
}

// ── GET /api/gmail/auth-url ───────────────────────────────────────────────────
gmailRouter.get("/auth-url", requireAuth, asyncHandler(async (req, res) => {
  if (!config.googleClientId || config.googleClientId === "PLACEHOLDER_REPLACE_WITH_REAL") {
    throw new HttpError(503, "Gmail integration not configured yet. Please add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your Render environment variables.");
  }
  res.json({ url: buildAuthUrl(req.user.hotelId) });
}));

// ── GET /api/gmail/callback ───────────────────────────────────────────────────
// Public — Google redirects here after user approves OAuth
gmailRouter.get("/callback", asyncHandler(async (req, res) => {
  const { code, state: hotelId, error } = req.query;

  if (error || !code || !hotelId) {
    console.error("[gmail callback] OAuth error:", error || "missing code/state");
    return res.redirect(`${config.clientUrl}?gmail_error=true#settings`);
  }

  try {
    const tokens = await exchangeCode(code);
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    const profile = await getGmailProfile(tokens.access_token);
    const emailAddress = profile.emailAddress;

    await query(
      `INSERT INTO email_integrations
         (hotel_id, provider, access_token, refresh_token, token_expiry, email_address, is_active)
       VALUES ($1, 'gmail', $2, $3, $4, $5, true)
       ON CONFLICT (hotel_id, provider) DO UPDATE SET
         access_token  = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, email_integrations.refresh_token),
         token_expiry  = EXCLUDED.token_expiry,
         email_address = EXCLUDED.email_address,
         is_active     = true,
         updated_at    = now()`,
      [
        hotelId,
        tokens.access_token,
        tokens.refresh_token || null,
        tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
        emailAddress,
      ]
    );

    console.log(`[gmail] Hotel ${hotelId} connected ${emailAddress}`);
    res.redirect(`${config.clientUrl}?gmail_connected=true#settings`);
  } catch (err) {
    console.error("[gmail callback] failed:", err.message);
    res.redirect(`${config.clientUrl}?gmail_error=true#settings`);
  }
}));

// ── GET /api/gmail/status ─────────────────────────────────────────────────────
gmailRouter.get("/status", requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT email_address, is_active, updated_at FROM email_integrations WHERE hotel_id = $1 AND provider = 'gmail'",
    [req.user.hotelId]
  );
  if (!rows.length || !rows[0].is_active) return res.json({ connected: false });
  res.json({ connected: true, email: rows[0].email_address, updated_at: rows[0].updated_at });
}));

// ── DELETE /api/gmail/disconnect ──────────────────────────────────────────────
gmailRouter.delete("/disconnect", requireAuth, asyncHandler(async (req, res) => {
  await query(
    "UPDATE email_integrations SET is_active = false WHERE hotel_id = $1 AND provider = 'gmail'",
    [req.user.hotelId]
  );
  res.json({ ok: true });
}));

// ── POST /api/gmail/scan ──────────────────────────────────────────────────────
gmailRouter.post("/scan", requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM email_integrations WHERE hotel_id = $1 AND provider = 'gmail' AND is_active = true",
    [req.user.hotelId]
  );
  if (!rows.length) throw new HttpError(400, "Gmail not connected");

  const accessToken = await getValidToken(rows[0], req.user.hotelId);
  const queryStr = "from:(airbnb.com OR booking.com OR expedia.com OR vrbo.com) subject:(reservation OR booking OR confirmation) newer_than:30d";

  const list = await listMessages(accessToken, queryStr, 20);
  if (!list.messages?.length) return res.json({ found: 0, bookings: [] });

  const parsedBookings = [];

  for (const msg of list.messages.slice(0, 10)) {
    try {
      const full = await getMessage(accessToken, msg.id);
      const parsed = parseOTAEmail(full);
      if (!parsed) continue;

      const { rows: existing } = await query(
        "SELECT id FROM bookings WHERE hotel_id = $1 AND source_reference = $2",
        [req.user.hotelId, msg.id]
      );
      if (!existing.length) {
        parsedBookings.push({ ...parsed, gmail_message_id: msg.id });
      }
    } catch (e) {
      console.error("[gmail scan parse]", e.message);
    }
  }

  res.json({ found: parsedBookings.length, bookings: parsedBookings });
}));

// ── POST /api/gmail/confirm-import ────────────────────────────────────────────
gmailRouter.post("/confirm-import", requireAuth, asyncHandler(async (req, res) => {
  const { bookings } = req.body;
  if (!Array.isArray(bookings) || !bookings.length) throw new HttpError(400, "bookings array required");

  const { rows: rooms } = await query(
    "SELECT id, number FROM rooms WHERE hotel_id = $1",
    [req.user.hotelId]
  );
  if (!rooms.length) throw new HttpError(400, "No rooms found for this hotel");

  const created = [];
  const failed  = [];

  for (const b of bookings) {
    try {
      let roomId = null;
      if (b.room_name) {
        const numMatch = String(b.room_name).match(/\d+/);
        if (numMatch) {
          const found = rooms.find(r => String(r.number) === numMatch[0]);
          roomId = found?.id || null;
        }
      }
      if (!roomId) roomId = rooms[0].id;

      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      const dayAfter  = new Date(); dayAfter.setDate(dayAfter.getDate() + 2);
      const checkIn   = b.check_in  || tomorrow.toISOString().slice(0, 10);
      const checkOut  = b.check_out || dayAfter.toISOString().slice(0, 10);

      const booking = await createBookingFromDraft({
        hotelId: req.user.hotelId,
        draft: {
          guestName:     b.guest_name  || "Gmail Guest",
          guestEmail:    b.guest_email || `imported-${Date.now()}@gmail-import.local`,
          guestPhone:    b.guest_phone || "",
          roomId,
          packageId:     null,
          packageType:   "standard",
          checkIn,
          checkOut,
          facilityIds:   [],
          specialNotes:  `Imported from Gmail (${b.source || "gmail"}) — ${(b.subject || "").slice(0, 200)}`,
          bookingSource: b.source || "gmail",
          importedAt:    new Date().toISOString(),
        },
      });

      await query(
        "UPDATE bookings SET source_reference = $1 WHERE id = $2",
        [b.gmail_message_id, booking.id]
      );

      created.push({ name: b.guest_name, booking_id: booking.id });
    } catch (e) {
      console.error("[gmail confirm]", e.message);
      failed.push({ name: b.guest_name, error: e.message });
    }
  }

  res.json({ created: created.length, failed: failed.length, details: created });
}));

// ── Email body parser ─────────────────────────────────────────────────────────
function parseOTAEmail(messageData) {
  try {
    const headers = messageData.payload?.headers || [];
    const from    = headers.find(h => h.name === "From")?.value    || "";
    const subject = headers.find(h => h.name === "Subject")?.value || "";

    let body = "";
    function extractBody(part) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        body += Buffer.from(part.body.data, "base64").toString("utf-8");
      } else if (part.mimeType === "text/html" && !body && part.body?.data) {
        body += Buffer.from(part.body.data, "base64").toString("utf-8")
          .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      }
      if (part.parts) part.parts.forEach(extractBody);
    }
    extractBody(messageData.payload);

    let source = "gmail";
    if (from.includes("airbnb"))       source = "airbnb";
    else if (from.includes("booking")) source = "booking_com";
    else if (from.includes("expedia")) source = "expedia";
    else if (from.includes("vrbo"))    source = "vrbo";

    const namePatterns = [
      /Guest\s+name[:\s]+([A-Za-zÀ-ÿ\s\-'\.]{2,50})/i,
      /Reservation\s+for[:\s]+([A-Za-zÀ-ÿ\s\-'\.]{2,50})/i,
      /Booked\s+by[:\s]+([A-Za-zÀ-ÿ\s\-'\.]{2,50})/i,
      /Name[:\s]+([A-Za-zÀ-ÿ\s\-'\.]{2,50})/i,
      /Guest[:\s]+([A-Za-zÀ-ÿ\s\-'\.]{2,50})/i,
    ];
    let guestName = null;
    for (const p of namePatterns) {
      const m = body.match(p);
      if (m) { guestName = m[1].trim().replace(/\s+/g, " "); break; }
    }

    const checkInPatterns = [
      /Check[\s\-]in[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
      /Arrival[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    ];
    let checkIn = null;
    for (const p of checkInPatterns) {
      const m = body.match(p);
      if (m) { const d = new Date(m[1]); if (!isNaN(d)) { checkIn = d.toISOString().slice(0, 10); break; } }
    }

    const checkOutPatterns = [
      /Check[\s\-]out[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
      /Departure[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    ];
    let checkOut = null;
    for (const p of checkOutPatterns) {
      const m = body.match(p);
      if (m) { const d = new Date(m[1]); if (!isNaN(d)) { checkOut = d.toISOString().slice(0, 10); break; } }
    }

    const emailMatches = [...body.matchAll(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g)]
      .map(m => m[1])
      .filter(e => !e.includes("airbnb") && !e.includes("booking") && !e.includes("expedia") && !e.includes("noreply"));
    const guestEmail = emailMatches[0] || null;

    if (!guestName && !checkIn) return null;

    return {
      guest_name:  guestName || `Guest (${source})`,
      guest_email: guestEmail,
      check_in:    checkIn,
      check_out:   checkOut,
      source,
      subject,
      raw_preview: body.substring(0, 300),
    };
  } catch {
    return null;
  }
}
