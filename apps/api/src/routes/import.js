import { Router }        from "express";
import multer            from "multer";
import { parse }         from "csv-parse/sync";
import { query }         from "../db/pool.js";
import { requireAuth }   from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";
import { createBookingFromDraft }  from "../services/bookings.js";

export const importRouter = Router();
importRouter.use(requireAuth);

// In-memory file upload (max 5 MB)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Column name normalisation ─────────────────────────────────────────────────
function normalise(header) {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

const FIELD_MAP = {
  guest_name:  ["guest_name","name","guest name"],
  guest_email: ["guest_email","email","e_mail","guest email"],
  room:        ["room","room_number","room number","room_no"],
  check_in:    ["check_in","checkin","check in","arrival","arrival_date"],
  check_out:   ["check_out","checkout","check out","departure","departure_date"],
  package:     ["package","package_name","package name"],
  phone:       ["phone","guest_phone","mobile","telephone"],
  source:      ["source","booking_source"],
};

function mapRow(rawRow) {
  const normalised = {};
  for (const [key, val] of Object.entries(rawRow)) {
    normalised[normalise(key)] = (val ?? "").toString().trim();
  }
  const out = {};
  for (const [field, aliases] of Object.entries(FIELD_MAP)) {
    for (const alias of aliases) {
      if (normalised[alias] !== undefined) { out[field] = normalised[alias]; break; }
    }
  }
  return out;
}

function parseDate(str) {
  if (!str) return null;
  // Accept ISO, DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY, etc.
  const iso = new Date(str);
  if (!isNaN(iso)) return iso;
  // DD/MM/YYYY
  const dmY = str.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmY) {
    const d = new Date(`${dmY[3]}-${dmY[2].padStart(2,"0")}-${dmY[1].padStart(2,"0")}`);
    if (!isNaN(d)) return d;
  }
  return null;
}

// ── POST /api/import/bookings/preview ─────────────────────────────────────────
importRouter.post("/bookings/preview", upload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, "No CSV file uploaded");

  let records;
  try {
    records = parse(req.file.buffer.toString("utf8"), {
      columns:          true,
      skip_empty_lines: true,
      trim:             true,
    });
  } catch (err) {
    throw new HttpError(400, `CSV parse error: ${err.message}`);
  }

  // Load rooms for this hotel once
  const { rows: rooms } = await query(
    "SELECT id, number, type FROM rooms WHERE hotel_id = $1",
    [req.user.hotelId]
  );
  const roomByNumber = new Map(rooms.map(r => [String(r.number).toLowerCase(), r]));

  // Load packages for matching
  const { rows: packages } = await query(
    "SELECT id, name FROM packages WHERE hotel_id = $1",
    [req.user.hotelId]
  );
  const pkgByName = new Map(packages.map(p => [p.name.toLowerCase(), p]));

  const preview = [];
  let valid_rows = 0;
  let error_rows = 0;

  for (let i = 0; i < records.length; i++) {
    const mapped = mapRow(records[i]);
    const errors = [];

    if (!mapped.guest_name) errors.push("Missing guest name");
    if (!mapped.guest_email) errors.push("Missing guest email");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mapped.guest_email)) errors.push("Invalid email");
    if (!mapped.room) errors.push("Missing room");
    if (!mapped.check_in) errors.push("Missing check-in date");
    if (!mapped.check_out) errors.push("Missing check-out date");

    const checkIn  = parseDate(mapped.check_in);
    const checkOut = parseDate(mapped.check_out);
    if (mapped.check_in  && !checkIn)  errors.push("Invalid check-in date format");
    if (mapped.check_out && !checkOut) errors.push("Invalid check-out date format");
    if (checkIn && checkOut && checkOut <= checkIn) errors.push("Check-out must be after check-in");

    let room = null;
    if (mapped.room) {
      room = roomByNumber.get(String(mapped.room).toLowerCase());
      if (!room) errors.push(`Room "${mapped.room}" not found`);
    }

    let pkg = null;
    if (mapped.package) {
      pkg = pkgByName.get(mapped.package.toLowerCase());
      // Not finding the package is a warning but not a hard error
    }

    const status = errors.length === 0 ? "valid" : "error";
    if (status === "valid") valid_rows++;
    else error_rows++;

    preview.push({
      row:          i + 1,
      guest_name:   mapped.guest_name  || "",
      guest_email:  mapped.guest_email || "",
      room_name:    room ? `Room ${room.number}` : (mapped.room || ""),
      room_id:      room?.id || null,
      check_in:     checkIn  ? checkIn.toISOString().slice(0, 10)  : mapped.check_in  || "",
      check_out:    checkOut ? checkOut.toISOString().slice(0, 10) : mapped.check_out || "",
      package_name: pkg?.name || mapped.package || "",
      package_id:   pkg?.id   || null,
      phone:        mapped.phone  || "",
      source:       mapped.source || "csv",
      status,
      errors,
    });
  }

  res.json({ total_rows: records.length, valid_rows, error_rows, preview });
}));

// ── POST /api/import/bookings/confirm ─────────────────────────────────────────
importRouter.post("/bookings/confirm", asyncHandler(async (req, res) => {
  const { preview } = req.body;
  if (!Array.isArray(preview)) throw new HttpError(400, "preview array required");

  const valid = preview.filter(r => r.status === "valid");
  if (!valid.length) throw new HttpError(400, "No valid rows to import");

  const results = [];
  const errors  = [];

  for (const row of valid) {
    try {
      const booking = await createBookingFromDraft({
        hotelId: req.user.hotelId,
        draft: {
          guestName:     row.guest_name,
          guestEmail:    row.guest_email,
          guestPhone:    row.phone || "",
          roomId:        row.room_id,
          packageId:     row.package_id || null,
          packageType:   row.package_name ? "premium" : "standard",
          checkIn:       row.check_in,
          checkOut:      row.check_out,
          facilityIds:   [],
          specialNotes:  "",
          bookingSource: row.source || "csv",
          importedAt:    new Date().toISOString(),
        },
      });
      results.push({ row: row.row, booking_id: booking.id, guest_name: row.guest_name });
    } catch (err) {
      errors.push({ row: row.row, guest_name: row.guest_name, error: err.message });
    }
  }

  res.json({
    created: results.length,
    failed:  errors.length,
    results,
    errors,
  });
}));
