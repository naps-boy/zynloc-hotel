import { query } from "../db/pool.js";

// ── Access Provider Interface ─────────────────────────────────────────────────
// Zynloc calls this — never calls Seam or any vendor directly.
// This layer can swap vendors without touching any other code.

export class AccessProvider {
  constructor(hotelId) {
    this.hotelId = hotelId;
    this.provider = null;
  }

  async initialize() {
    const result = await query(
      "SELECT * FROM access_providers WHERE hotel_id = $1 AND is_active = true LIMIT 1",
      [this.hotelId]
    );
    if (result.rows.length === 0) {
      this.provider = null;
      return false;
    }
    const config = result.rows[0];
    if (config.provider_type === "seam") {
      this.provider = new SeamProvider(config);
    }
    return true;
  }

  async issueCredential({ bookingId, guestId, roomId, validFrom, validUntil, credentialType = "guest" }) {
    // Log to access_credentials regardless of whether a physical provider is connected
    const credRecord = await query(
      `INSERT INTO access_credentials
         (hotel_id, booking_id, guest_id, room_id, provider_type, credential_type, valid_from, valid_until, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING id`,
      [
        this.hotelId, bookingId, guestId, roomId,
        this.provider?.providerType || "none", credentialType, validFrom, validUntil,
      ]
    );
    const credId = credRecord.rows[0].id;

    if (!this.provider) {
      // No physical lock connected — credential is software-only (QR based)
      await query("UPDATE access_credentials SET status = $1 WHERE id = $2", ["active", credId]);
      return { credentialId: credId, type: "software", message: "No physical lock connected" };
    }

    try {
      // Get the device mapped to this room
      const deviceResult = await query(
        "SELECT device_id FROM room_devices WHERE hotel_id = $1 AND room_id = $2 AND provider_type = $3",
        [this.hotelId, roomId, this.provider.providerType]
      );

      if (deviceResult.rows.length === 0) {
        await query("UPDATE access_credentials SET status = $1 WHERE id = $2", ["no_device", credId]);
        return { credentialId: credId, type: "software", message: "No lock device mapped to this room" };
      }

      const deviceId = deviceResult.rows[0].device_id;
      const result = await this.provider.issueCredential({ deviceId, validFrom, validUntil, credentialType });

      await query(
        `UPDATE access_credentials
           SET external_credential_id = $1, access_code = $2, status = 'active'
         WHERE id = $3`,
        [result.externalId, result.accessCode || null, credId]
      );

      return { credentialId: credId, type: "physical", ...result };
    } catch (err) {
      await query("UPDATE access_credentials SET status = $1 WHERE id = $2", ["failed", credId]);
      console.error("[AccessProvider] issueCredential error:", err.message);
      return { credentialId: credId, type: "failed", error: err.message };
    }
  }

  async revokeCredential(credentialId) {
    const credResult = await query(
      "SELECT * FROM access_credentials WHERE id = $1 AND hotel_id = $2",
      [credentialId, this.hotelId]
    );
    if (!credResult.rows[0]) return { success: false, error: "Credential not found" };

    const cred = credResult.rows[0];

    if (this.provider && cred.external_credential_id) {
      try {
        await this.provider.revokeCredential(cred.external_credential_id);
      } catch (err) {
        console.error("[AccessProvider] revokeCredential error:", err.message);
      }
    }

    await query(
      "UPDATE access_credentials SET status = $1, revoked_at = now() WHERE id = $2",
      ["revoked", credentialId]
    );

    return { success: true };
  }

  async listDevices() {
    if (!this.provider) return [];
    try {
      return await this.provider.listDevices();
    } catch (err) {
      console.error("[AccessProvider] listDevices error:", err.message);
      return [];
    }
  }
}

// ── Seam Provider Implementation ──────────────────────────────────────────────

class SeamProvider {
  constructor(config) {
    this.providerType = "seam";
    this.apiKey = config.api_key_encrypted;
    this.workspaceId = config.workspace_id;
  }

  async getClient() {
    const { Seam } = await import("seam");
    return new Seam({ apiKey: this.apiKey });
  }

  async listDevices() {
    const seam = await this.getClient();
    const devices = await seam.devices.list();
    return devices.map(d => ({
      deviceId:     d.device_id,
      name:         d.properties?.name || d.device_id,
      type:         d.device_type,
      isOnline:     d.properties?.online || false,
      batteryLevel: d.properties?.battery_level ?? null,
    }));
  }

  async issueCredential({ deviceId, validFrom, validUntil, credentialType }) {
    const seam = await this.getClient();
    const accessCode = await seam.accessCodes.create({
      device_id:  deviceId,
      name:       `Zynloc-${credentialType}-${Date.now()}`,
      starts_at:  validFrom.toISOString(),
      ends_at:    validUntil.toISOString(),
    });
    return {
      externalId:  accessCode.access_code_id,
      accessCode:  accessCode.code,
      startsAt:    validFrom,
      endsAt:      validUntil,
    };
  }

  async revokeCredential(externalCredentialId) {
    const seam = await this.getClient();
    await seam.accessCodes.delete({ access_code_id: externalCredentialId });
  }
}
