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

async function listMessages(accessToken, queryStr, maxResults = 20, pageToken = null) {
  const params = { q: queryStr, maxResults: String(maxResults) };
  if (pageToken) params.pageToken = pageToken;
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?" + new URLSearchParams(params),
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

// Get a valid access token — refresh if expired or expiring within 5 minutes
async function getValidToken(int, hotelId) {
  const expiresAt   = int.token_expiry ? new Date(int.token_expiry).getTime() : 0;
  // 5-minute buffer: refresh if token expires in the next 5 min
  const needsRefresh = !int.access_token || expiresAt < Date.now() + 5 * 60 * 1000;

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

// ── Shared scan logic — used by both the route and the background job ─────────
export async function scanHotelGmailInbox(hotelId, { maxResults = 20, pageToken = null } = {}) {
  const { rows } = await query(
    "SELECT * FROM email_integrations WHERE hotel_id = $1 AND provider = 'gmail' AND is_active = true",
    [hotelId]
  );
  if (!rows.length) return { found: 0, bookings: [], nextPageToken: null };

  const accessToken = await getValidToken(rows[0], hotelId);
  const queryStr = "from:(airbnb.com OR booking.com OR expedia.com OR vrbo.com OR tripadvisor.com OR hotels.com) subject:(reservation OR booking OR confirmation) newer_than:30d";

  const safeMax = Math.min(maxResults, 100);
  const list = await listMessages(accessToken, queryStr, safeMax, pageToken);

  // Record this scan time regardless of whether emails were found
  await query(
    "UPDATE email_integrations SET last_scan_at = now(), updated_at = now() WHERE hotel_id = $1 AND provider = 'gmail'",
    [hotelId]
  ).catch(err => console.warn("[gmail last_scan_at]", err.message));

  if (!list.messages?.length) return { found: 0, bookings: [], nextPageToken: null };

  const parsedBookings = [];
  // Cap per-request message fetches to avoid slow responses
  const toFetch = list.messages.slice(0, Math.min(safeMax, 10));

  for (const msg of toFetch) {
    try {
      const full   = await getMessage(accessToken, msg.id);
      const parsed = parseOTAEmail(full);
      if (!parsed) continue;

      const { rows: existing } = await query(
        "SELECT id FROM bookings WHERE hotel_id = $1 AND source_reference = $2",
        [hotelId, msg.id]
      );
      if (!existing.length) {
        parsedBookings.push({ ...parsed, gmail_message_id: msg.id });
      }
    } catch (e) {
      console.error("[gmail scan parse]", e.message);
    }
  }

  return { found: parsedBookings.length, bookings: parsedBookings, nextPageToken: list.nextPageToken || null };
}

// ── GET /api/gmail/auth-url ───────────────────────────────────────────────────
gmailRouter.get("/auth-url", requireAuth, asyncHandler(async (req, res) => {
  if (!config.googleClientId || config.googleClientId === "PLACEHOLDER_REPLACE_WITH_REAL") {
    // Return 200 with configured: false so the frontend can show "Coming Soon"
    // (throwing a 5xx here would surface as "Internal server error" in production)
    return res.json({
      configured: false,
      error: "Gmail integration is not yet configured. Please contact Zynloc support to enable this feature.",
    });
  }
  res.json({ configured: true, url: buildAuthUrl(req.user.hotelId) });
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

    const profile      = await getGmailProfile(tokens.access_token);
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
    "SELECT email_address, is_active, updated_at, last_scan_at FROM email_integrations WHERE hotel_id = $1 AND provider = 'gmail'",
    [req.user.hotelId]
  );
  if (!rows.length || !rows[0].is_active) return res.json({ connected: false });

  // Count bookings imported via Gmail (any OTA source that came through inbox scan)
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total
       FROM bookings
      WHERE hotel_id = $1
        AND source_reference IS NOT NULL
        AND booking_source IN ('airbnb','booking_com','expedia','vrbo','tripadvisor','hotels_com','gmail')`,
    [req.user.hotelId]
  );

  res.json({
    connected:        true,
    email:            rows[0].email_address,
    updated_at:       rows[0].updated_at,
    last_scan_at:     rows[0].last_scan_at || null,
    imported_count:   countRows[0].total,
  });
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
  // Optional pagination params
  const maxResults = Math.min(parseInt(req.query.limit) || 20, 100);
  const pageToken  = req.query.pageToken || null;

  const result = await scanHotelGmailInbox(req.user.hotelId, { maxResults, pageToken });
  res.json(result);
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
    const from    = headers.find(h => h.name.toLowerCase() === "from")?.value    || "";
    const subject = headers.find(h => h.name.toLowerCase() === "subject")?.value || "";
    const date    = headers.find(h => h.name.toLowerCase() === "date")?.value    || "";

    // Extract body — plain text preferred, fall back to HTML stripped of tags
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

    // Determine booking source from sender domain
    let source = "gmail";
    const fromLower = from.toLowerCase();
    if      (fromLower.includes("airbnb"))       source = "airbnb";
    else if (fromLower.includes("booking.com"))  source = "booking_com";
    else if (fromLower.includes("expedia"))      source = "expedia";
    else if (fromLower.includes("vrbo"))         source = "vrbo";
    else if (fromLower.includes("tripadvisor"))  source = "tripadvisor";
    else if (fromLower.includes("hotels.com"))   source = "hotels_com";

    // Guest name — multiple patterns, most specific first
    const namePatterns = [
      /(?:Guest|Customer|Traveler|Booker)\s*(?:name|Name)[:\s]+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-'\.]{1,50})/i,
      /(?:Reservation|Booking)\s+for\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-'\.]{1,50})/i,
      /Booked\s+by[:\s]+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-'\.]{1,50})/i,
      /Hi\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-']{1,30}),/i,
      /Dear\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-']{1,30}),/i,
      /Name[:\s]+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-'\.]{1,50})/i,
      /Guest[:\s]+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-'\.]{1,50})/i,
    ];
    let guestName = null;
    for (const p of namePatterns) {
      const m = body.match(p);
      if (m && m[1].trim().length > 2) { guestName = m[1].trim().replace(/\s+/g, " "); break; }
    }

    // Check-in date — ISO, US and EU formats
    const checkInPatterns = [
      /(?:Check[\s\-]?in|Arrival|From)\s*[:\-]?\s*(\d{4}[\-\/]\d{2}[\-\/]\d{2})/i,
      /(?:Check[\s\-]?in|Arrival|From)\s*[:\-]?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
      /(?:Check[\s\-]?in|Arrival|From)\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    ];
    let checkIn = null;
    for (const p of checkInPatterns) {
      const m = body.match(p);
      if (m) { const d = new Date(m[1]); if (!isNaN(d)) { checkIn = d.toISOString().slice(0, 10); break; } }
    }

    // Check-out date
    const checkOutPatterns = [
      /(?:Check[\s\-]?out|Departure|To|Until)\s*[:\-]?\s*(\d{4}[\-\/]\d{2}[\-\/]\d{2})/i,
      /(?:Check[\s\-]?out|Departure|To|Until)\s*[:\-]?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
      /(?:Check[\s\-]?out|Departure|To|Until)\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    ];
    let checkOut = null;
    for (const p of checkOutPatterns) {
      const m = body.match(p);
      if (m) { const d = new Date(m[1]); if (!isNaN(d)) { checkOut = d.toISOString().slice(0, 10); break; } }
    }

    // Guest email — exclude OTA noreply addresses
    const emailMatches = [...body.matchAll(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g)]
      .map(m => m[1])
      .filter(e =>
        !e.includes("airbnb") && !e.includes("booking") &&
        !e.includes("expedia") && !e.includes("noreply") &&
        !e.includes("vrbo") && !e.includes("tripadvisor")
      );
    const guestEmail = emailMatches[0] || null;

    // Confirmation / reservation number
    const confirmPatterns = [
      /(?:Confirmation|Reservation|Booking)\s*(?:number|#|code|ID|No\.?)[:\s]+([A-Z0-9]{4,20})/i,
      /(?:Ref|Reference)[:\s#]+([A-Z0-9]{4,20})/i,
      /(?:Order|Itinerary)\s*#?[:\s]+([A-Z0-9]{4,20})/i,
    ];
    let confirmationNumber = null;
    for (const p of confirmPatterns) {
      const m = body.match(p);
      if (m) { confirmationNumber = m[1]; break; }
    }

    if (!guestName && !checkIn) return null;

    return {
      guest_name:          guestName || `Guest (${source})`,
      guest_email:         guestEmail,
      check_in:            checkIn,
      check_out:           checkOut,
      source,
      subject,
      confirmation_number: confirmationNumber,
      email_date:          date,
      raw_preview:         body.substring(0, 400),
    };
  } catch (e) {
    console.error("[parseOTAEmail]", e.message);
    return null;
  }
}
