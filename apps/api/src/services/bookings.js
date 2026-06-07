import { query, withTransaction } from "../db/pool.js";
import { sendBookingConfirmation } from "./email.js";
import { createBookingQr, rotateCheckinQr } from "./qr.js";
import { emitHotel } from "./realtime.js";

export async function createBookingFromDraft({ hotelId, draft }) {
  const booking = await withTransaction(async (client) => {
    const room = (await client.query(
      "SELECT * FROM rooms WHERE id = $1 AND hotel_id = $2",
      [draft.roomId, hotelId]
    )).rows[0];
    if (!room) throw new Error("Room not found");

    const checkIn  = new Date(draft.checkIn);
    const checkOut = new Date(draft.checkOut);
    const nights   = Math.max(1, Math.ceil((checkOut - checkIn) / 86400000));

    // Determine price: package price takes precedence if set, otherwise room * nights
    let amount = nights * Number(room.price_per_night);
    if (draft.packageId) {
      const pkg = (await client.query(
        "SELECT price FROM packages WHERE id = $1 AND hotel_id = $2",
        [draft.packageId, hotelId]
      )).rows[0];
      if (pkg && Number(pkg.price) > 0) amount = Number(pkg.price);
    }

    const guest = (await client.query(
      `INSERT INTO guests (hotel_id, name, email, phone)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [hotelId, draft.guestName, draft.guestEmail, draft.guestPhone || ""]
    )).rows[0];

    const created = (await client.query(
      `INSERT INTO bookings
         (hotel_id, guest_id, room_id, package_type, check_in, check_out,
          amount, special_notes, package_id, profile_status, guest_phone,
          booking_source, imported_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12)
       RETURNING *`,
      [
        hotelId, guest.id, draft.roomId,
        draft.packageType || "standard",
        checkIn, checkOut, amount,
        draft.specialNotes || "",
        draft.packageId || null,
        draft.guestPhone || "",
        draft.bookingSource || "manual",
        draft.importedAt   || null,
      ]
    )).rows[0];

    // Facility access: from explicit list or from package
    const facilityIds = new Set(draft.facilityIds || []);
    if (draft.packageId) {
      const pkgFacilities = (await client.query(
        "SELECT facility_id FROM package_facilities WHERE package_id = $1",
        [draft.packageId]
      )).rows;
      pkgFacilities.forEach((r) => facilityIds.add(r.facility_id));
    }
    for (const facilityId of facilityIds) {
      await client.query(
        `INSERT INTO facility_access (hotel_id, booking_id, facility_id, included)
         VALUES ($1,$2,$3,TRUE) ON CONFLICT DO NOTHING`,
        [hotelId, created.id, facilityId]
      );
    }

    // Mark room occupied
    await client.query("UPDATE rooms SET status = 'occupied' WHERE id = $1", [draft.roomId]);

    return { ...created, guest, room_number: room.number };
  });

  // Generate long-lived access QR
  const qr = await createBookingQr({ hotelId, bookingId: booking.id, expiresAt: booking.check_out });

  // Generate first rotating check-in QR
  await rotateCheckinQr(booking.id);

  const hotel = (await query("SELECT * FROM hotels WHERE id = $1", [hotelId])).rows[0];
  // Send confirmation email to the guest using the hotel's configured SMTP
  await sendBookingConfirmation({ guest: booking.guest, hotel, booking, qr, hotelId });
  emitHotel(hotelId, "bookings:changed", { ...booking, qr_token: qr.token, qr_data_url: qr.qr_data_url });
  return { ...booking, qr_token: qr.token, qr_data_url: qr.qr_data_url };
}
