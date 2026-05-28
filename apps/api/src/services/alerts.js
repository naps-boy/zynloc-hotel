import { query } from "../db/pool.js";
import { emitHotel } from "./realtime.js";

export async function createAlert({ hotelId, type, title, message, bookingId, guestName }) {
  try {
    const { rows } = await query(
      `INSERT INTO alerts (hotel_id, type, title, message, booking_id, guest_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [hotelId, type, title, message || null, bookingId || null, guestName || null]
    );
    emitHotel(hotelId, "new:alert", rows[0]);
    return rows[0];
  } catch (err) {
    console.error("[createAlert] failed:", err.message);
  }
}
