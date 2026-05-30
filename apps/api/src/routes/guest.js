import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { getQrPayload, rotateCheckinQr } from "../services/qr.js";
import { emitHotel, emitBooking } from "../services/realtime.js";
import { sendCheckoutReceipt } from "../services/email.js";
import { createAlert } from "../services/alerts.js";
import { asyncHandler, HttpError } from "../utils/http.js";

export const guestRouter = Router();

// ─── Resolve access token → attach qr payload to request ─────────────────────
async function requireValidQr(req, _res, next) {
  try {
    const qr = await getQrPayload(req.params.token);
    if (!qr) throw new HttpError(404, "Access link not found");
    if (qr.status === "past" || qr.status === "cancelled") {
      throw new HttpError(410, "This booking has ended");
    }
    if (qr.revoked) {
      throw new HttpError(403, "Your access has been revoked. Please contact the hotel.");
    }
    req.qr = qr;
    next();
  } catch (err) { next(err); }
}

// ─── GET /api/guest/find — find booking by email or reference ────────────────
// PUBLIC — no auth. Used by ScanReceptionPage when guest has no sessionStorage token.
// Must be placed BEFORE /:token to avoid Express matching "find" as a token.
guestRouter.get("/find", asyncHandler(async (req, res) => {
  const { email, reference, hotel } = req.query;
  if (!hotel) return res.status(400).json({ error: "Hotel ID required" });

  let result;
  if (email) {
    result = await query(
      `SELECT q.token qr_token, b.id, g.name guest_name, b.status, q.revoked
         FROM bookings b
         JOIN qr_codes q ON q.booking_id = b.id
         JOIN guests   g ON g.id         = b.guest_id
        WHERE b.hotel_id          = $1
          AND LOWER(g.email)      = LOWER($2)
          AND b.status NOT IN ('past', 'cancelled')
          AND q.revoked           = false
          AND b.check_out         > now()
        ORDER BY b.check_in ASC
        LIMIT 1`,
      [hotel, email]
    );
  } else if (reference) {
    result = await query(
      `SELECT q.token qr_token, b.id, g.name guest_name, b.status, q.revoked
         FROM bookings b
         JOIN qr_codes q ON q.booking_id = b.id
         JOIN guests   g ON g.id         = b.guest_id
        WHERE b.hotel_id          = $1
          AND UPPER(b.id::text)   LIKE UPPER($2)
          AND b.status NOT IN ('past', 'cancelled')
          AND q.revoked           = false
        ORDER BY b.check_in ASC
        LIMIT 1`,
      [hotel, `%${reference}%`]
    );
  } else {
    return res.status(400).json({ error: "Email or booking reference required" });
  }

  if (!result.rows.length) {
    return res.status(404).json({
      error: "No active booking found. Please check your email address or contact reception.",
    });
  }

  const b = result.rows[0];
  res.json({ ok: true, token: b.qr_token, guest_name: b.guest_name, booking_id: b.id });
}));

// ─── GET /api/guest/:token — load booking + facilities ────────────────────────
guestRouter.get("/:token", requireValidQr, asyncHandler(async (req, res) => {
  const access = await query(
    `SELECT f.id, f.name, f.description, f.zone, f.icon,
            fa.included
       FROM facilities f
       LEFT JOIN facility_access fa
             ON fa.facility_id = f.id AND fa.booking_id = $1
      WHERE f.hotel_id = $2
      ORDER BY f.name`,
    [req.qr.booking_id, req.qr.hotel_id]
  );

  // Navigation data (v2 schema)
  const { rows: floorPlans } = await query(
    "SELECT * FROM floor_plans WHERE hotel_id = $1 ORDER BY floor_number",
    [req.qr.hotel_id]
  ).catch(() => ({ rows: [] }));
  const { rows: navWaypoints } = await query(
    "SELECT * FROM nav_waypoints WHERE hotel_id = $1 ORDER BY name",
    [req.qr.hotel_id]
  ).catch(() => ({ rows: [] }));
  const { rows: navPaths } = await query(
    "SELECT * FROM nav_paths WHERE hotel_id = $1",
    [req.qr.hotel_id]
  ).catch(() => ({ rows: [] }));

  // Messages for this guest
  const messages = await query(
    `SELECT m.*, s.name staff_name FROM messages m
       LEFT JOIN staff s ON s.id = m.staff_id
      WHERE m.hotel_id = $1 AND (m.guest_id = $2 OR m.broadcast = TRUE)
      ORDER BY m.created_at ASC LIMIT 100`,
    [req.qr.hotel_id, req.qr.guest_id]
  );

  res.json({
    booking: req.qr,
    facilities: access.rows,
    floorPlans,
    waypoints: navWaypoints,
    paths: navPaths,
    messages: messages.rows,
  });
}));

// ─── POST /:token/profile — complete guest profile (selfie + name) ────────────
guestRouter.post("/:token/profile", requireValidQr, asyncHandler(async (req, res) => {
  const body = z.object({
    name:      z.string().min(2),
    selfieUrl: z.string().min(10),   // base64 data URL from file input
  }).parse(req.body);

  await query(
    `UPDATE guests
        SET name = $1, selfie_url = $2, profile_complete = TRUE
      WHERE id = $3`,
    [body.name, body.selfieUrl, req.qr.guest_id]
  );
  await query(
    "UPDATE bookings SET profile_status = 'complete' WHERE id = $1",
    [req.qr.booking_id]
  );

  const notif = (await query(
    `INSERT INTO notifications (hotel_id, guest_id, type, title, body, event_type, guest_photo)
     VALUES ($1,$2,'service','Profile complete',$3,'profile_complete',$4) RETURNING *`,
    [
      req.qr.hotel_id, req.qr.guest_id,
      `${body.name} has completed their profile — ready for check-in`,
      body.selfieUrl
    ]
  )).rows[0];
  emitHotel(req.qr.hotel_id, "notifications:new", notif);
  emitHotel(req.qr.hotel_id, "bookings:changed", { id: req.qr.booking_id });

  res.json({ ok: true });
}));

// ─── GET /:token/checkin-qr — get/refresh the rotating check-in QR ───────────
guestRouter.get("/:token/checkin-qr", requireValidQr, asyncHandler(async (req, res) => {
  const booking = (await query(
    "SELECT checkin_token, checkin_token_expires_at FROM bookings WHERE id = $1",
    [req.qr.booking_id]
  )).rows[0];

  const expired = !booking.checkin_token || new Date(booking.checkin_token_expires_at) < new Date(Date.now() - 60000);
  if (expired) {
    const fresh = await rotateCheckinQr(req.qr.booking_id);
    return res.json(fresh);
  }

  // Re-generate QR image for existing token (token unchanged, just need the data URL)
  const { default: QRCode } = await import("qrcode");
  const { config } = await import("../config.js");
  const url = `${config.clientUrl}/checkin-scan/${booking.checkin_token}`;
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 2, width: 360 });
  res.json({ token: booking.checkin_token, expires_at: booking.checkin_token_expires_at, qr_data_url: qrDataUrl });
}));

// ─── POST /:token/checkin — receptionist confirms check-in after visual ID ────
guestRouter.post("/:token/checkin", requireValidQr, asyncHandler(async (req, res) => {
  await query("UPDATE bookings SET status = 'current' WHERE id = $1", [req.qr.booking_id]);
  const notif = (await query(
    `INSERT INTO notifications (hotel_id, guest_id, type, title, body, event_type, guest_photo)
     VALUES ($1,$2,'checkin','Guest checked in',$3,'checkin',$4) RETURNING *`,
    [req.qr.hotel_id, req.qr.guest_id,
     `${req.qr.guest_name} checked into room ${req.qr.room_number}`,
     req.qr.selfie_url]
  )).rows[0];
  emitHotel(req.qr.hotel_id, "notifications:new", notif);
  emitHotel(req.qr.hotel_id, "bookings:changed", { id: req.qr.booking_id, status: "current" });
  emitBooking(req.qr.booking_id, "checkin:confirmed", { roomNumber: req.qr.room_number });
  createAlert({
    hotelId:   req.qr.hotel_id,
    type:      "checkin",
    title:     `${req.qr.guest_name} checked in`,
    message:   `Room ${req.qr.room_number}`,
    bookingId: req.qr.booking_id,
    guestName: req.qr.guest_name,
  }).catch(() => {});
  res.json({ ok: true });
}));

// ─── POST /:token/scan-reception — guest scanned hotel reception QR ───────────
guestRouter.post("/:token/scan-reception", requireValidQr, asyncHandler(async (req, res) => {
  const { receptionToken } = z.object({ receptionToken: z.string() }).parse(req.body);
  const hotel = (await query(
    "SELECT id, reception_token, reception_token_expires_at FROM hotels WHERE id = $1",
    [req.qr.hotel_id]
  )).rows[0];

  if (!hotel?.reception_token || hotel.reception_token !== receptionToken) {
    throw new HttpError(404, "Invalid reception QR — please get a fresh one from the hotel");
  }
  if (new Date(hotel.reception_token_expires_at) < new Date()) {
    throw new HttpError(410, "Reception QR has expired — ask staff to refresh it");
  }

  emitHotel(req.qr.hotel_id, "guest:arrived", {
    bookingId:   req.qr.booking_id,
    guestName:   req.qr.guest_name,
    guestEmail:  req.qr.guest_email,
    selfieUrl:   req.qr.selfie_url,
    roomNumber:  req.qr.room_number,
    roomType:    req.qr.room_type,
    checkIn:     req.qr.check_in,
    checkOut:    req.qr.check_out,
    qrToken:     req.qr.token,
    packageType: req.qr.package_type,
  });

  createAlert({
    hotelId:   req.qr.hotel_id,
    type:      "arrival",
    title:     `${req.qr.guest_name} arrived at reception`,
    message:   `Room ${req.qr.room_number} · awaiting check-in confirmation`,
    bookingId: req.qr.booking_id,
    guestName: req.qr.guest_name,
  }).catch(() => {});

  res.json({ ok: true });
}));

// ─── POST /:token/checkout — guest-initiated checkout ─────────────────────────
guestRouter.post("/:token/checkout", requireValidQr, asyncHandler(async (req, res) => {
  await query("UPDATE bookings SET status = 'past' WHERE id = $1", [req.qr.booking_id]);
  await query("UPDATE qr_codes SET expires_at = NOW() WHERE id = $1", [req.qr.qr_id]);
  await query("UPDATE rooms SET status = 'cleaning' WHERE number = $1 AND hotel_id = $2",
    [req.qr.room_number, req.qr.hotel_id]);

  const notif = (await query(
    `INSERT INTO notifications (hotel_id, guest_id, type, title, body, event_type)
     VALUES ($1,$2,'checkout','Guest checked out',$3,'checkout') RETURNING *`,
    [req.qr.hotel_id, req.qr.guest_id,
     `${req.qr.guest_name} checked out of room ${req.qr.room_number}`]
  )).rows[0];
  emitHotel(req.qr.hotel_id, "notifications:new", notif);
  emitHotel(req.qr.hotel_id, "bookings:changed", {});
  emitHotel(req.qr.hotel_id, "rooms:changed", {});

  const hotel = (await query("SELECT * FROM hotels WHERE id = $1", [req.qr.hotel_id])).rows[0];
  const guest = (await query("SELECT * FROM guests WHERE id = $1", [req.qr.guest_id])).rows[0];
  const booking = (await query("SELECT * FROM bookings WHERE id = $1", [req.qr.booking_id])).rows[0];
  await sendCheckoutReceipt({ guest, hotel, booking: { ...booking, room_number: req.qr.room_number } });
  createAlert({
    hotelId:   req.qr.hotel_id,
    type:      "checkout",
    title:     `${req.qr.guest_name} checked out`,
    message:   `Room ${req.qr.room_number} — now cleaning`,
    bookingId: req.qr.booking_id,
    guestName: req.qr.guest_name,
  }).catch(() => {});
  res.json({ ok: true });
}));

// ─── POST /:token/checkout-scan — guest scanned checkout QR ──────────────────
guestRouter.post("/:token/checkout-scan", requireValidQr, asyncHandler(async (req, res) => {
  const { checkoutToken } = z.object({ checkoutToken: z.string() }).parse(req.body);
  const cqr = (await query(
    "SELECT * FROM checkout_qr_codes WHERE token = $1 AND hotel_id = $2",
    [checkoutToken, req.qr.hotel_id]
  )).rows[0];
  if (!cqr) throw new HttpError(404, "Invalid checkout QR");
  // Delegate to the checkout handler logic (inline here)
  await query("UPDATE bookings SET status = 'past' WHERE id = $1", [req.qr.booking_id]);
  await query("UPDATE qr_codes SET expires_at = NOW() WHERE id = $1", [req.qr.qr_id]);
  await query("UPDATE rooms SET status = 'cleaning' WHERE number = $1 AND hotel_id = $2",
    [req.qr.room_number, req.qr.hotel_id]);
  emitHotel(req.qr.hotel_id, "bookings:changed", {});
  emitHotel(req.qr.hotel_id, "rooms:changed", {});
  const hotel = (await query("SELECT * FROM hotels WHERE id = $1", [req.qr.hotel_id])).rows[0];
  const guest = (await query("SELECT * FROM guests WHERE id = $1", [req.qr.guest_id])).rows[0];
  const booking = (await query("SELECT * FROM bookings WHERE id = $1", [req.qr.booking_id])).rows[0];
  await sendCheckoutReceipt({ guest, hotel, booking: { ...booking, room_number: req.qr.room_number } });
  createAlert({
    hotelId:   req.qr.hotel_id,
    type:      "checkout",
    title:     `${req.qr.guest_name} checked out`,
    message:   `Room ${req.qr.room_number} — now cleaning`,
    bookingId: req.qr.booking_id,
    guestName: req.qr.guest_name,
  }).catch(() => {});
  res.json({ ok: true });
}));

// ─── POST /:token/facility-scan — guest scans facility QR ────────────────────
guestRouter.post("/:token/facility-scan", requireValidQr, asyncHandler(async (req, res) => {
  const { facilityToken } = z.object({ facilityToken: z.string() }).parse(req.body);

  if (req.qr.status !== "current") {
    throw new HttpError(403, "Check-in required before accessing facilities");
  }

  const fqr = (await query(
    "SELECT * FROM facility_qr_codes WHERE token = $1 AND hotel_id = $2",
    [facilityToken, req.qr.hotel_id]
  )).rows[0];
  if (!fqr) throw new HttpError(404, "Unknown facility QR");

  const access = (await query(
    "SELECT included FROM facility_access WHERE booking_id = $1 AND facility_id = $2",
    [req.qr.booking_id, fqr.facility_id]
  )).rows[0];

  const facility = (await query("SELECT name FROM facilities WHERE id = $1", [fqr.facility_id])).rows[0];
  const result = access?.included ? "access_granted" : "access_denied";

  await query(
    `INSERT INTO qr_scans (hotel_id, qr_code_id, facility_id, result)
     VALUES ($1,$2,$3,$4)`,
    [req.qr.hotel_id, req.qr.qr_id, fqr.facility_id, result]
  );

  if (result === "access_denied") {
    const notif = (await query(
      `INSERT INTO notifications (hotel_id, guest_id, type, title, body, event_type, guest_photo)
       VALUES ($1,$2,'service',$3,$4,'access_denied',$5) RETURNING *`,
      [
        req.qr.hotel_id, req.qr.guest_id,
        `Access denied — ${req.qr.guest_name}`,
        `${req.qr.guest_name} attempted to access ${facility?.name || "facility"} — not included in package`,
        req.qr.selfie_url
      ]
    )).rows[0];
    emitHotel(req.qr.hotel_id, "notifications:new", notif);
    emitHotel(req.qr.hotel_id, "access:denied", { ...notif, facilityName: facility?.name });
    createAlert({
      hotelId:   req.qr.hotel_id,
      type:      "access_denied",
      title:     `Access denied — ${req.qr.guest_name}`,
      message:   `Attempted ${facility?.name || "facility"} — not in package`,
      bookingId: req.qr.booking_id,
      guestName: req.qr.guest_name,
    }).catch(() => {});
  }

  res.json({ result, facilityName: facility?.name });
}));

// ─── POST /:token/messages — guest sends message ──────────────────────────────
guestRouter.post("/:token/messages", requireValidQr, asyncHandler(async (req, res) => {
  const body = z.object({ body: z.string().min(1) }).parse(req.body);
  const { rows } = await query(
    `INSERT INTO messages (hotel_id, guest_id, sender, body)
     VALUES ($1,$2,'guest',$3) RETURNING *`,
    [req.qr.hotel_id, req.qr.guest_id, body.body]
  );
  emitHotel(req.qr.hotel_id, "messages:new", rows[0]);
  res.status(201).json(rows[0]);
}));

// ─── POST /:token/service-requests — guest service request ───────────────────
guestRouter.post("/:token/service-requests", requireValidQr, asyncHandler(async (req, res) => {
  const body = z.object({
    type: z.enum(["room_cleaning","extra_towels","maintenance","food","custom"]),
    note: z.string().optional().default("")
  }).parse(req.body);

  const sr = (await query(
    `INSERT INTO service_requests (hotel_id, booking_id, guest_id, type, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.qr.hotel_id, req.qr.booking_id, req.qr.guest_id, body.type, body.note]
  )).rows[0];

  const notif = (await query(
    `INSERT INTO notifications (hotel_id, guest_id, type, title, body, event_type)
     VALUES ($1,$2,'service',$3,$4,'service_request') RETURNING *`,
    [
      req.qr.hotel_id, req.qr.guest_id,
      `${body.type.replace(/_/g, " ")} — Room ${req.qr.room_number}`,
      body.note || `${req.qr.guest_name} · Room ${req.qr.room_number}`
    ]
  )).rows[0];

  emitHotel(req.qr.hotel_id, "notifications:new", notif);
  emitHotel(req.qr.hotel_id, "service-requests:new", sr);
  createAlert({
    hotelId:   req.qr.hotel_id,
    type:      "service_request",
    title:     `${body.type.replace(/_/g, " ")} — Room ${req.qr.room_number}`,
    message:   body.note || `${req.qr.guest_name} · Room ${req.qr.room_number}`,
    bookingId: req.qr.booking_id,
    guestName: req.qr.guest_name,
  }).catch(() => {});
  res.status(201).json(sr);
}));

// ─── PUT /:token/location — update guest current location ────────────────────
guestRouter.put("/:token/location", requireValidQr, asyncHandler(async (req, res) => {
  const { location } = z.object({ location: z.string() }).parse(req.body);
  await query("UPDATE guests SET current_location = $1 WHERE id = $2", [location, req.qr.guest_id]);
  emitHotel(req.qr.hotel_id, "guests:location", { guestId: req.qr.guest_id, location });
  res.json({ ok: true });
}));

// ─── GET /:token/hotel-kyc — hotel KYC settings (no auth, guest-facing) ──────
// Returns the hotel's KYC requirements so ProfileSetup can show document upload.
// Does NOT return guest data or document_data.
guestRouter.get("/:token/hotel-kyc", asyncHandler(async (req, res) => {
  const qr = await getQrPayload(req.params.token).catch(() => null);
  if (!qr) return res.json({ kyc_required: false, kyc_documents: [], hotel_name: "", country: "" });
  const hotel = (await query(
    "SELECT name, kyc_required, kyc_documents, country FROM hotels WHERE id = $1",
    [qr.hotel_id]
  )).rows[0];
  if (!hotel) return res.json({ kyc_required: false, kyc_documents: [], hotel_name: "", country: "" });
  res.json({
    kyc_required:  hotel.kyc_required  || false,
    kyc_documents: hotel.kyc_documents || [],
    hotel_name:    hotel.name          || "",
    country:       hotel.country       || "",
  });
}));

// ─── POST /:token/documents — guest uploads a KYC document ───────────────────
guestRouter.post("/:token/documents", requireValidQr, asyncHandler(async (req, res) => {
  const { document_type, document_data } = z.object({
    document_type: z.string().min(1).max(100),
    document_data: z.string().min(10),         // base64 data URL
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO guest_documents (booking_id, hotel_id, document_type, document_data)
     VALUES ($1, $2, $3, $4) RETURNING id, document_type, uploaded_at, delete_at`,
    [req.qr.booking_id, req.qr.hotel_id, document_type, document_data]
  );
  // Never log document_data
  res.status(201).json({ ok: true, id: rows[0].id });
}));
