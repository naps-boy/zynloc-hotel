import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { HttpError } from "../utils/http.js";

export function signSession(staff) {
  return jwt.sign(
    { staffId: staff.id, hotelId: staff.hotel_id, role: staff.role, email: staff.email },
    config.jwtSecret,
    { expiresIn: "12h" }
  );
}

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return next(new HttpError(401, "Missing bearer token"));

  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    next(new HttpError(401, "Invalid or expired token"));
  }
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.user?.role)) {
      return next(new HttpError(403, "Insufficient permissions"));
    }
    next();
  };
}
