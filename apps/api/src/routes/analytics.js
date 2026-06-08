import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/http.js";

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

analyticsRouter.get("/", asyncHandler(async (req, res) => {
  const hotelId = req.user.hotelId;
  const [rooms, bookings, scans] = await Promise.all([
    query("SELECT id, number, type FROM rooms WHERE hotel_id = $1", [hotelId]),
    query(
      `SELECT b.*, r.number room_number, r.type room_type,
              COALESCE(r.price_per_night, 0) AS price_per_night
         FROM bookings b LEFT JOIN rooms r ON r.id = b.room_id
        WHERE b.hotel_id = $1 AND b.status <> 'cancelled'`,
      [hotelId]
    ),
    query(
      `SELECT f.name, qs.id scan_id
         FROM facilities f LEFT JOIN qr_scans qs ON qs.facility_id = f.id
        WHERE f.hotel_id = $1`,
      [hotelId]
    )
  ]);

  const roomCount = Math.max(rooms.rows.length, 1);
  const byMonth = new Map();
  const revenueByRoom = new Map(rooms.rows.map((room) => [room.number, 0]));
  const roomTypes = new Map();
  let totalNights = 0;

  for (const booking of bookings.rows) {
    const month = new Date(booking.check_in).toISOString().slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + 1);
    const nights = Math.max(1, Math.ceil((new Date(booking.check_out) - new Date(booking.check_in)) / 86400000));
    const roomRevenue    = Number(booking.price_per_night || 0) * nights;
    const packageRevenue = Number(booking.amount || 0);
    revenueByRoom.set(booking.room_number, (revenueByRoom.get(booking.room_number) || 0) + roomRevenue + packageRevenue);
    roomTypes.set(booking.room_type, (roomTypes.get(booking.room_type) || 0) + 1);
    totalNights += nights;
  }

  const facilityCounts = new Map();
  for (const scan of scans.rows) {
    facilityCounts.set(scan.name, (facilityCounts.get(scan.name) || 0) + (scan.scan_id ? 1 : 0));
  }

  res.json({
    occupancyByMonth: [...byMonth.entries()].map(([month, count]) => ({
      month,
      occupancy_rate: Math.round((count / roomCount) * 100)
    })),
    revenueByRoom: [...revenueByRoom.entries()].map(([room_number, revenue]) => ({ room_number, revenue })),
    averageLengthOfStay: bookings.rows.length ? Number((totalNights / bookings.rows.length).toFixed(2)) : 0,
    popularRoomTypes: [...roomTypes.entries()].map(([type, count]) => ({ type, bookings: count })),
    facilityUsage: [...facilityCounts.entries()].map(([name, scans]) => ({ name, scans }))
  });
}));
