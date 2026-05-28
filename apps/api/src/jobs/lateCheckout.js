import { query } from "../db/pool.js";
import { emitHotel } from "../services/realtime.js";
import { createAlert } from "../services/alerts.js";

export function startLateCheckoutMonitor() {
  setInterval(async () => {
    const { rows } = await query(
      `SELECT b.id, b.hotel_id, g.name guest_name, r.number room_number
         FROM bookings b
         JOIN guests g ON g.id = b.guest_id
         JOIN rooms r ON r.id = b.room_id
        WHERE b.status = 'current' AND b.check_out < NOW()`
    );
    for (const row of rows) {
      const notification = (await query(
        `INSERT INTO notifications (hotel_id, type, title, body)
         VALUES ($1, 'late_checkout', 'Late checkout alert', $2) RETURNING *`,
        [row.hotel_id, `${row.guest_name} has not checked out of room ${row.room_number}`]
      )).rows[0];
      emitHotel(row.hotel_id, "notifications:new", notification);

      // Create an alert only if no unresolved late_checkout alert exists for this booking
      const existing = await query(
        `SELECT id FROM alerts WHERE hotel_id = $1 AND booking_id = $2
           AND type = 'late_checkout' AND resolved = FALSE LIMIT 1`,
        [row.hotel_id, row.id]
      );
      if (existing.rows.length === 0) {
        createAlert({
          hotelId:   row.hotel_id,
          type:      "late_checkout",
          title:     `Late checkout — ${row.guest_name}`,
          message:   `Room ${row.room_number} — should have checked out`,
          bookingId: row.id,
          guestName: row.guest_name,
        }).catch(() => {});
      }
    }
  }, 5 * 60 * 1000).unref();
}
