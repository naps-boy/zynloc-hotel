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

// ─── POST /api/access-control/enable ─────────────────────────────────────────
// Hotels enable access control — no API key needed, uses Zynloc master key.

accessControlRouter.post("/enable", asyncHandler(async (req, res) => {
  const masterKey = process.env.SEAM_API_KEY;
  if (!masterKey || masterKey === "PLACEHOLDER_ADD_YOUR_SEAM_KEY_HERE") {
    throw new HttpError(503, "Access control not available. Contact Zynloc support.");
  }

  await query(
    `INSERT INTO access_providers (hotel_id, provider_type, provider_name, is_active)
     VALUES ($1, 'seam', 'Seam', true)
     ON CONFLICT (hotel_id, provider_type) DO UPDATE SET is_active = true, updated_at = now()`,
    [req.user.hotelId]
  );

  // Test connection using master key — get device count for confirmation
  const provider = new AccessProvider(req.user.hotelId);
  await provider.initialize();
  const devices = await provider.listDevices();

  res.json({ success: true, deviceCount: devices.length });
}));

// ─── DELETE /api/access-control/disable ──────────────────────────────────────

accessControlRouter.delete("/disable", asyncHandler(async (req, res) => {
  await query(
    "UPDATE access_providers SET is_active = false WHERE hotel_id = $1",
    [req.user.hotelId]
  );
  res.json({ success: true });
}));

// ─── POST /api/access-control/create-webview ─────────────────────────────────
// Creates a Seam Connect Webview so the hotel can authorise their lock brand account.
// Returns a one-time URL that the frontend opens in a popup.

accessControlRouter.post("/create-webview", asyncHandler(async (req, res) => {
  const seamKey = process.env.SEAM_API_KEY;
  if (!seamKey || seamKey === "PLACEHOLDER_ADD_YOUR_SEAM_KEY_HERE") {
    throw new HttpError(503, "Access control not available. Contact Zynloc support.");
  }

  // Fetch hotel name for labelling the webview
  const hotelRes = await query("SELECT name FROM hotels WHERE id = $1", [req.user.hotelId]);
  const hotelName = hotelRes.rows[0]?.name || "Hotel";

  const result = await fetch("https://connect.getseam.com/connect_webviews/create", {
    method: "POST",
    headers: { "Authorization": "Bearer " + seamKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      accepted_providers: [
        "august", "schlage", "yale", "salto", "igloohome",
        "dormakaba", "kwikset", "lockly", "nuki", "ttlock",
        "assa_abloy", "brivo", "latch",
      ],
      custom_metadata: { hotel_id: req.user.hotelId, hotel_name: hotelName },
    }),
  });

  const data = await result.json();
  if (!result.ok || !data.connect_webview) {
    console.error("[access-control] create-webview failed:", data);
    throw new HttpError(500, "Failed to create lock connection flow. Please try again.");
  }

  const webview = data.connect_webview;

  // Store the webview ID against this hotel so we can verify completion later
  await query(
    `INSERT INTO access_providers (hotel_id, provider_type, provider_name, workspace_id, is_active, config)
     VALUES ($1, 'seam', 'Seam', $2, false, $3)
     ON CONFLICT (hotel_id, provider_type) DO UPDATE SET
       workspace_id = $2, config = $3, is_active = false, updated_at = now()`,
    [
      req.user.hotelId,
      webview.connect_webview_id,
      JSON.stringify({ webview_url: webview.url, webview_id: webview.connect_webview_id }),
    ]
  );

  res.json({ webview_url: webview.url, webview_id: webview.connect_webview_id });
}));

// ─── POST /api/access-control/verify-webview ─────────────────────────────────
// Called after the hotel closes the Connect Webview popup.
// Checks if the OAuth flow completed and activates access control if so.

accessControlRouter.post("/verify-webview", asyncHandler(async (req, res) => {
  const { webviewId } = req.body;
  if (!webviewId) throw new HttpError(400, "webviewId required");

  const seamKey = process.env.SEAM_API_KEY;
  if (!seamKey || seamKey === "PLACEHOLDER_ADD_YOUR_SEAM_KEY_HERE") {
    throw new HttpError(503, "Access control not available. Contact Zynloc support.");
  }

  const result = await fetch("https://connect.getseam.com/connect_webviews/get", {
    method: "POST",
    headers: { "Authorization": "Bearer " + seamKey, "Content-Type": "application/json" },
    body: JSON.stringify({ connect_webview_id: webviewId }),
  });

  const data = await result.json();
  const webview = data.connect_webview;

  if (!webview || !webview.login_successful) {
    return res.json({ success: false, message: "Lock connection not completed yet" });
  }

  // Fetch devices connected via this account so we can record them
  const devicesResult = await fetch("https://connect.getseam.com/devices/list", {
    method: "POST",
    headers: { "Authorization": "Bearer " + seamKey, "Content-Type": "application/json" },
    body: JSON.stringify({ connected_account_id: webview.connected_account_id }),
  });
  const devicesData = await devicesResult.json();
  const devices = devicesData.devices || [];

  // Mark this hotel's access control as active; store connected_account_id in config
  await query(
    `UPDATE access_providers
        SET is_active = true,
            config    = config || $1::jsonb,
            updated_at = now()
      WHERE hotel_id = $2 AND provider_type = 'seam'`,
    [
      JSON.stringify({ connected_account_id: webview.connected_account_id }),
      req.user.hotelId,
    ]
  );

  res.json({
    success:              true,
    connected_account_id: webview.connected_account_id,
    device_count:         devices.length,
    devices: devices.map(d => ({
      deviceId:  d.device_id,
      name:      d.properties?.name || d.device_id,
      type:      d.device_type,
      isOnline:  d.properties?.online || false,
    })),
  });
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
