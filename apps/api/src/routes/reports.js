import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/http.js";

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

reportsRouter.get("/bookings.csv", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT b.id, g.name guest_name, g.email guest_email, r.number room_number, r.type room_type,
            b.package_type, b.promo_code, b.check_in, b.check_out, b.status, b.amount
       FROM bookings b
       LEFT JOIN guests g ON g.id = b.guest_id
       LEFT JOIN rooms r ON r.id = b.room_id
      WHERE b.hotel_id = $1
      ORDER BY b.check_in DESC`,
    [req.user.hotelId]
  );
  const headers = ["Booking ID", "Guest", "Email", "Room", "Room Type", "Package", "Promo Code", "Check In", "Check Out", "Status", "Revenue"];
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => [
      row.id,
      row.guest_name,
      row.guest_email,
      row.room_number,
      row.room_type,
      row.package_type,
      row.promo_code,
      row.check_in,
      row.check_out,
      row.status,
      row.amount
    ].map(csvCell).join(","))
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=zynloc-bookings-report.csv");
  res.send(lines.join("\n"));
}));
