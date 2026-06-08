import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../utils/http.js";
import { AccessProvider } from "../services/access-provider.js";

export const accessControlRouter = Router();
accessControlRouter.use(requireAuth);

// ─── GET /api/access-control/status ──────────────────────────────────────────

accessControlRouter.get("/status", asyncHandler(async (req, res) => {
  const result = await query(
    "SELECT provider_type, provider_name, is_active, workspace_id, updated_at FROM access_providers WHERE hotel_id = $1",
    [req.user.hotelId]
  );
  if (result.rows.length === 0) return res.json({ connected: false });
  const p = result.rows[0];
  res.json({
    connected:   p.is_active,
    provider:    p.provider_type,
    name:        p.provider_name,
    workspaceId: p.workspace_id,
    updatedAt:   p.updated_at,
  });
}));

// ─── POST /api/access-control/connect ────────────────────────────────────────

accessControlRouter.post("/connect", asyncHandler(async (req, res) => {
  const { apiKey, workspaceId, providerType = "seam" } = req.body;
  if (!apiKey) throw new HttpError(400, "API key required");

  // Verify the API key works by listing devices
  let deviceCount = 0;
  try {
    const { Seam } = await import("seam");
    const seam = new Seam({ apiKey });
    const devices = await seam.devices.list();
    deviceCount = devices.length;
  } catch (err) {
    throw new HttpError(400, "Invalid Seam API key: " + err.message);
  }

  await query(
    `INSERT INTO access_providers
       (hotel_id, provider_type, provider_name, api_key_encrypted, workspace_id, is_active)
     VALUES ($1, $2, 'Seam', $3, $4, true)
     ON CONFLICT (hotel_id, provider_type) DO UPDATE SET
       api_key_encrypted = $3, workspace_id = $4, is_active = true, updated_at = now()`,
    [req.user.hotelId, providerType, apiKey, workspaceId || null]
  );

  res.json({ success: true, deviceCount });
}));

// ─── DELETE /api/access-control/disconnect ───────────────────────────────────

accessControlRouter.delete("/disconnect", asyncHandler(async (req, res) => {
  await query(
    "UPDATE access_providers SET is_active = false WHERE hotel_id = $1",
    [req.user.hotelId]
  );
  res.json({ success: true });
}));

// ─── GET /api/access-control/devices ─────────────────────────────────────────

accessControlRouter.get("/devices", asyncHandler(async (req, res) => {
  const provider = new AccessProvider(req.user.hotelId);
  await provider.initialize();
  const devices = await provider.listDevices();

  // Get room mappings — rooms use `number` not `name`
  const mappings = await query(
    `SELECT rd.device_id, rd.room_id, r.number AS room_number
       FROM room_devices rd
       JOIN rooms r ON r.id = rd.room_id
      WHERE rd.hotel_id = $1`,
    [req.user.hotelId]
  );
  const mappingMap = {};
  for (const m of mappings.rows) mappingMap[m.device_id] = { roomId: m.room_id, roomNumber: m.room_number };

  const devicesWithRooms = devices.map(d => ({
    ...d,
    mappedRoom: mappingMap[d.deviceId] || null,
  }));

  res.json({ devices: devicesWithRooms });
}));

// ─── POST /api/access-control/devices/map ────────────────────────────────────

accessControlRouter.post("/devices/map", asyncHandler(async (req, res) => {
  const { roomId, deviceId, deviceName, deviceType } = req.body;
  if (!roomId || !deviceId) throw new HttpError(400, "roomId and deviceId required");

  await query(
    `INSERT INTO room_devices
       (hotel_id, room_id, device_id, device_name, device_type, provider_type)
     VALUES ($1, $2, $3, $4, $5, 'seam')
     ON CONFLICT (hotel_id, room_id, provider_type) DO UPDATE SET
       device_id = $3, device_name = $4, device_type = $5`,
    [req.user.hotelId, roomId, deviceId, deviceName || deviceId, deviceType || "smart_lock"]
  );

  res.json({ success: true });
}));

// ─── GET /api/access-control/credentials ─────────────────────────────────────

accessControlRouter.get("/credentials", asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT ac.*, g.name AS guest_name, r.number AS room_number
       FROM access_credentials ac
       LEFT JOIN guests g ON g.id = ac.guest_id
       LEFT JOIN rooms  r ON r.id = ac.room_id
      WHERE ac.hotel_id = $1
      ORDER BY ac.created_at DESC
      LIMIT 50`,
    [req.user.hotelId]
  );
  res.json(result.rows);
}));

// ─── POST /api/access-control/credentials/issue ──────────────────────────────

accessControlRouter.post("/credentials/issue", asyncHandler(async (req, res) => {
  const { bookingId, guestId, roomId, validFrom, validUntil, credentialType } = req.body;

  const provider = new AccessProvider(req.user.hotelId);
  await provider.initialize();

  const result = await provider.issueCredential({
    bookingId, guestId, roomId,
    validFrom:  new Date(validFrom),
    validUntil: new Date(validUntil),
    credentialType: credentialType || "guest",
  });

  res.json(result);
}));

// ─── DELETE /api/access-control/credentials/:id ──────────────────────────────

accessControlRouter.delete("/credentials/:id", asyncHandler(async (req, res) => {
  const provider = new AccessProvider(req.user.hotelId);
  await provider.initialize();
  const result = await provider.revokeCredential(req.params.id);
  res.json(result);
}));
