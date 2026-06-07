import { Router }     from "express";
import { google }     from "googleapis";
import { query }      from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";
import { createBookingFromDraft }  from "../services/bookings.js";
import { config }     from "../config.js";

export const gmailRouter = Router();

function getOAuthClient() {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    config.googleRedirectUri
  );
}

// ── GET /api/gmail/auth-url ───────────────────────────────────────────────────
// Returns the Google OAuth URL the manager should be redirected to.
gmailRouter.get("/auth-url", requireAuth, asyncHandler(async (req, res) => {
  if (!config.googleClientId || config.googleClientId === "PLACEHOLDER_REPLACE_WITH_REAL") {
    throw new HttpError(503, "Gmail integration not configured yet. Please add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your Render environment variables.");
  }
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope:       ["https://www.googleapis.com/auth/gmail.readonly"],
    state:       req.user.hotelId,   // passed back in callback so we know which hotel
    prompt:      "consent",          // force refresh_token every time
  });
  res.json({ url });
}));

// ── GET /api/gmail/callback ───────────────────────────────────────────────────
// Public endpoint — Google redirects here after user approves OAuth.
// No requireAuth — the hotelId is carried in the `state` param.
gmailRouter.get("/callback", asyncHandler(async (req, res) => {
  const { code, state: hotelId, error } = req.query;

  if (error || !code || !hotelId) {
    console.error("[gmail callback] OAuth error:", error || "missing code/state");
    return res.redirect(`${config.clientUrl}?gmail_error=true#settings`);
  }

  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Fetch the Gmail address that just connected
    const gmail   = google.gmail({ version: "v1", auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const emailAddress = profile.data.emailAddress;

    // Upsert — one Gmail row per hotel
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
        tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        emailAddress,
      ]
    );

    console.log(`[gmail] Hotel ${hotelId} connected ${emailAddress}`);
    res.redirect(`${config.clientUrl}?gmail_connected=true#settings`);
  } catch (err) {
    console.error("[gmail callback] token exchange failed:", err.message);
    res.redirect(`${config.clientUrl}?gmail_error=true#settings`);
  }
}));

// ── GET /api/gmail/status ─────────────────────────────────────────────────────
gmailRouter.get("/status", requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT email_address, is_active, updated_at
       FROM email_integrations
      WHERE hotel_id = $1 AND provider = 'gmail'`,
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
// Scan inbox for OTA booking confirmation emails. Returns parsed previews.
gmailRouter.post("/scan", requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM email_integrations WHERE hotel_id = $1 AND provider = 'gmail' AND is_active = true",
    [req.user.hotelId]
  );
  if (!rows.length) throw new HttpError(400, "Gmail not connected");

  const int = rows[0];
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token:  int.access_token,
    refresh_token: int.refresh_token,
    expiry_date:   int.token_expiry ? new Date(int.token_expiry).getTime() : null,
  });

  // Persist refreshed tokens automatically
  oauth2Client.on("tokens", (tokens) => {
    if (tokens.access_token) {
      query(
        `UPDATE email_integrations
            SET access_token = $1, token_expiry = $2, updated_at = now()
          WHERE hotel_id = $3 AND provider = 'gmail'`,
        [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, req.user.hotelId]
      ).catch(err => console.warn("[gmail token refresh]", err.message));
    }
  });

  const gmail    = google.gmail({ version: "v1", auth: oauth2Client });
  const queryStr = "from:(airbnb.com OR booking.com OR expedia.com OR vrbo.com) subject:(reservation OR booking OR confirmation) newer_than:30d";

  const listRes = await gmail.users.messages.list({
    userId:     "me",
    q:          queryStr,
    maxResults: 20,
  });

  if (!listRes.data.messages?.length) return res.json({ found: 0, bookings: [] });

  const parsedBookings = [];

  for (const msg of listRes.data.messages.slice(0, 10)) {
    try {
      const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
      const parsed = parseOTAEmail(full.data);
      if (!parsed) continue;

      // Skip emails already imported
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
// Create real bookings from the parsed Gmail results.
// Uses createBookingFromDraft so guests, QRs, emails all work correctly.
gmailRouter.post("/confirm-import", requireAuth, asyncHandler(async (req, res) => {
  const { bookings } = req.body;
  if (!Array.isArray(bookings) || !bookings.length) {
    throw new HttpError(400, "bookings array required");
  }

  // Load rooms for best-effort matching
  const { rows: rooms } = await query(
    "SELECT id, number FROM rooms WHERE hotel_id = $1",
    [req.user.hotelId]
  );
  if (!rooms.length) throw new HttpError(400, "No rooms found for this hotel");

  const created = [];
  const failed  = [];

  for (const b of bookings) {
    try {
      // Match a room by number extracted from parsed room_name, else use first room
      let roomId = null;
      if (b.room_name) {
        const numMatch = String(b.room_name).match(/\d+/);
        if (numMatch) {
          const found = rooms.find(r => String(r.number) === numMatch[0]);
          roomId = found?.id || null;
        }
      }
      if (!roomId) roomId = rooms[0].id;

      // Validate we have usable dates — fall back to tomorrow/day-after if totally missing
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      const dayAfter = new Date(); dayAfter.setDate(dayAfter.getDate() + 2);
      const checkIn  = b.check_in  || tomorrow.toISOString().slice(0, 10);
      const checkOut = b.check_out || dayAfter.toISOString().slice(0, 10);

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

      // Stamp the Gmail message ID so re-scans skip this email
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
    const headers   = messageData.payload.headers || [];
    const from      = headers.find(h => h.name === "From")?.value    || "";
    const subject   = headers.find(h => h.name === "Subject")?.value || "";

    // Decode body (plain text preferred; fall back to HTML stripped of tags)
    let body = "";
    function extractBody(part) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        body += Buffer.from(part.body.data, "base64").toString("utf-8");
      } else if (part.mimeType === "text/html" && !body && part.body?.data) {
        // Strip HTML tags as last resort
        body += Buffer.from(part.body.data, "base64").toString("utf-8")
          .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      }
      if (part.parts) part.parts.forEach(extractBody);
    }
    extractBody(messageData.payload);

    // Determine OTA source
    let source = "gmail";
    if (from.includes("airbnb"))       source = "airbnb";
    else if (from.includes("booking")) source = "booking_com";
    else if (from.includes("expedia")) source = "expedia";
    else if (from.includes("vrbo"))    source = "vrbo";

    // Guest name
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

    // Check-in date
    const checkInPatterns = [
      /Check[\s\-]in[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
      /Arrival[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    ];
    let checkIn = null;
    for (const p of checkInPatterns) {
      const m = body.match(p);
      if (m) { const d = new Date(m[1]); if (!isNaN(d)) { checkIn = d.toISOString().slice(0, 10); break; } }
    }

    // Check-out date
    const checkOutPatterns = [
      /Check[\s\-]out[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
      /Departure[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    ];
    let checkOut = null;
    for (const p of checkOutPatterns) {
      const m = body.match(p);
      if (m) { const d = new Date(m[1]); if (!isNaN(d)) { checkOut = d.toISOString().slice(0, 10); break; } }
    }

    // Guest email (skip the hotel's own email)
    const emailMatches = [...body.matchAll(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g)]
      .map(m => m[1])
      .filter(e => !e.includes("airbnb") && !e.includes("booking") && !e.includes("expedia") && !e.includes("noreply"));
    const guestEmail = emailMatches[0] || null;

    // Need at least a name or a check-in date to be useful
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
