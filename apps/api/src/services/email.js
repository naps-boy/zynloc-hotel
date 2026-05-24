import nodemailer from "nodemailer";
import { query } from "../db/pool.js";
import { config } from "../config.js";

// ── SMTP config lookup ────────────────────────────────────────────────────────

/**
 * Fetch the default SMTP config for a hotel.
 * Returns null if none has been configured yet.
 */
export async function getHotelSmtpConfig(hotelId) {
  const { rows } = await query(
    "SELECT * FROM smtp_configs WHERE hotel_id = $1 AND is_default = TRUE LIMIT 1",
    [hotelId]
  );
  return rows[0] || null;
}

/**
 * Create a nodemailer transporter from an smtp_configs row.
 */
function createTransporter(cfg) {
  return nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   cfg.smtp_port,
    family: 4,             // Force IPv4 — Render free tier blocks IPv6 egress (ENETUNREACH)
    secure: cfg.smtp_port === 465,   // TLS on 465, STARTTLS on 587/25
    auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
    tls: { rejectUnauthorized: false },  // allow self-signed certs
    connectionTimeout: 30_000,   // 30 s — Render free tier can be slow to route
    greetingTimeout:   10_000,   // 10 s for SMTP greeting
    socketTimeout:     45_000,   // 45 s per socket operation
  });
}

/**
 * Send a test email using a specific SMTP config row.
 * Returns { ok, messageId, error }.
 */
export async function sendTestEmail(smtpCfg, toAddress) {
  const testHtml = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0d1b2a;color:#e2e8f0;padding:32px">
<div style="max-width:480px;margin:auto;background:#162235;border-radius:16px;padding:32px;text-align:center">
  <h2 style="color:#d8a84f;margin:0 0 12px">SMTP connection verified</h2>
  <p style="color:#9aa6b2;margin:0">Your email configuration is working correctly.<br>Zynloc Hotel will now send guest emails from this address.</p>
  <p style="color:#9aa6b2;margin:24px 0 0;font-size:12px">Sent from: ${smtpCfg.email} via ${smtpCfg.smtp_host}:${smtpCfg.smtp_port}</p>
</div></body></html>`;

  const tryPort = async (port) => {
    const t = createTransporter({ ...smtpCfg, smtp_port: port });
    return t.sendMail({
      from:    `"${smtpCfg.sender_name}" <${smtpCfg.email}>`,
      to:      toAddress,
      subject: "Zynloc Hotel — SMTP test",
      html:    testHtml,
    });
  };

  // Connection-level error codes that warrant a port fallback
  const isConnErr = code => ["ECONNECTION","ETIMEDOUT","ENETUNREACH","ECONNREFUSED"].includes(code);

  try {
    const info = await tryPort(smtpCfg.smtp_port);
    console.log(`[Email] Test email sent — messageId=${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email] Test failed on port ${smtpCfg.smtp_port}: [${err.code}] ${err.message}`);

    // Auto-retry on port 465 when 587 fails with a TCP/routing error
    if (smtpCfg.smtp_port === 587 && isConnErr(err.code)) {
      console.log("[Email] Retrying on port 465 (TLS)…");
      try {
        const info = await tryPort(465);
        console.log(`[Email] Test email sent via fallback 465 — messageId=${info.messageId}`);
        return { ok: true, messageId: info.messageId };
      } catch (err2) {
        console.error(`[Email] Fallback port 465 also failed: [${err2.code}] ${err2.message}`);
        return { ok: false, error: err2.message, code: err2.code };
      }
    }
    return { ok: false, error: err.message, code: err.code };
  }
}

// ── Internal send helper ──────────────────────────────────────────────────────

/**
 * Send an email using the hotel's default SMTP config.
 * Silently skips (logs warning) if no SMTP config is set.
 */
async function send({ hotelId, to, subject, html, attachments = [] }) {
  const smtpCfg = await getHotelSmtpConfig(hotelId);
  if (!smtpCfg) {
    console.warn(`[Email] No SMTP config for hotel ${hotelId} — skipping "${subject}"`);
    return;
  }

  const transporter = createTransporter(smtpCfg);
  const mailOpts = {
    from:    `"${smtpCfg.sender_name}" <${smtpCfg.email}>`,
    to:      Array.isArray(to) ? to.join(", ") : to,
    subject,
    html,
  };

  if (attachments.length) {
    mailOpts.attachments = attachments.map(a => ({
      filename: a.filename,
      content:  Buffer.from(a.content, "base64"),
      encoding: "base64",
    }));
  }

  console.log(`[Email] Sending "${subject}" to ${mailOpts.to} via ${smtpCfg.smtp_host}:${smtpCfg.smtp_port}`);
  try {
    const info = await transporter.sendMail(mailOpts);
    console.log(`[Email] Sent — messageId=${info.messageId}`);
  } catch (err) {
    // Log but don't crash the request — email failure must never block a booking
    console.error(`[Email] Failed to send "${subject}":`, err.message);
  }
}

// ── Transactional emails ──────────────────────────────────────────────────────

/**
 * Booking confirmation — sent to the guest's email with their access QR attached.
 * hotelId is used to look up the hotel's SMTP config.
 */
export async function sendBookingConfirmation({ guest, hotel, booking, qr, hotelId }) {
  const guestLink = `${config.clientUrl}/guest/${qr.token}`;
  await send({
    hotelId,
    to: guest.email,
    subject: `Your booking at ${hotel.name} — ${new Date(booking.check_in).toLocaleDateString()}`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0d1b2a;color:#e2e8f0;padding:32px">
<div style="max-width:520px;margin:auto;background:#162235;border-radius:16px;padding:32px">

  <div style="text-align:center;margin:0 0 28px">
    <div style="display:inline-block;background:#d8a84f;border-radius:12px;padding:12px 20px">
      <span style="font-size:24px;font-weight:bold;color:#0d1b2a">${hotel.name}</span>
    </div>
    <h1 style="color:#e2e8f0;margin:16px 0 4px;font-size:22px">Booking confirmed</h1>
    <p style="color:#9aa6b2;margin:0;font-size:14px">Your stay has been reserved</p>
  </div>

  <table style="width:100%;border-collapse:collapse;margin:0 0 28px;background:#0d1b2a;border-radius:12px;overflow:hidden">
    <tr style="border-bottom:1px solid #243044">
      <td style="padding:12px 16px;color:#9aa6b2;font-size:13px;width:40%">Guest</td>
      <td style="padding:12px 16px;color:#e2e8f0;font-weight:600">${guest.name}</td>
    </tr>
    <tr style="border-bottom:1px solid #243044">
      <td style="padding:12px 16px;color:#9aa6b2;font-size:13px">Room</td>
      <td style="padding:12px 16px;color:#e2e8f0;font-weight:600">${booking.room_number}</td>
    </tr>
    <tr style="border-bottom:1px solid #243044">
      <td style="padding:12px 16px;color:#9aa6b2;font-size:13px">Check-in</td>
      <td style="padding:12px 16px;color:#e2e8f0">${new Date(booking.check_in).toLocaleString()}</td>
    </tr>
    <tr style="border-bottom:1px solid #243044">
      <td style="padding:12px 16px;color:#9aa6b2;font-size:13px">Check-out</td>
      <td style="padding:12px 16px;color:#e2e8f0">${new Date(booking.check_out).toLocaleString()}</td>
    </tr>
    <tr style="border-bottom:1px solid #243044">
      <td style="padding:12px 16px;color:#9aa6b2;font-size:13px">Amount</td>
      <td style="padding:12px 16px;color:#d8a84f;font-weight:700">$${Number(booking.amount || 0).toFixed(2)}</td>
    </tr>
    ${booking.special_notes ? `<tr><td style="padding:12px 16px;color:#9aa6b2;font-size:13px">Notes</td><td style="padding:12px 16px;color:#e2e8f0">${booking.special_notes}</td></tr>` : ""}
  </table>

  <div style="background:#0d1b2a;border-radius:12px;padding:24px;margin:0 0 24px;border:1px solid #243044;text-align:center">
    <h2 style="color:#d8a84f;margin:0 0 8px;font-size:16px">Complete your profile</h2>
    <p style="color:#9aa6b2;margin:0 0 20px;font-size:14px">
      Tap the button below to open your guest app, upload your photo, and breeze through check-in.
      Your access QR code is also attached to this email.
    </p>
    <a href="${guestLink}"
       style="display:inline-block;background:#d8a84f;color:#0d1b2a;padding:14px 32px;border-radius:8px;font-weight:700;text-decoration:none;font-size:15px">
      Open Guest App →
    </a>
  </div>

  <p style="color:#4a5568;font-size:11px;text-align:center;margin:0">
    If the button doesn't work, copy this link: ${guestLink}
  </p>

</div></body></html>`,
    attachments: qr.qr_data_url
      ? [{ filename: "zynloc-access-qr.png", content: qr.qr_data_url.split(",")[1] }]
      : [],
  });
}

/**
 * Checkout receipt — sent to the guest after checkout.
 */
export async function sendCheckoutReceipt({ guest, hotel, booking }) {
  const nights = Math.max(1, Math.ceil(
    (new Date(booking.check_out) - new Date(booking.check_in)) / 86_400_000
  ));
  await send({
    hotelId: hotel.id,
    to: guest.email,
    subject: `Thank you for staying at ${hotel.name}`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0d1b2a;color:#e2e8f0;padding:32px">
<div style="max-width:520px;margin:auto;background:#162235;border-radius:16px;padding:32px">

  <div style="text-align:center;margin:0 0 28px">
    <h1 style="color:#d8a84f;margin:0 0 8px;font-size:26px">Thank you, ${guest.name}</h1>
    <p style="color:#9aa6b2;margin:0;font-size:15px">We hope you enjoyed your stay at ${hotel.name}</p>
  </div>

  <table style="width:100%;border-collapse:collapse;margin:0 0 28px;background:#0d1b2a;border-radius:12px;overflow:hidden">
    <tr style="border-bottom:1px solid #243044">
      <td style="padding:12px 16px;color:#9aa6b2;font-size:13px;width:40%">Room</td>
      <td style="padding:12px 16px;color:#e2e8f0;font-weight:600">${booking.room_number}</td>
    </tr>
    <tr style="border-bottom:1px solid #243044">
      <td style="padding:12px 16px;color:#9aa6b2;font-size:13px">Nights</td>
      <td style="padding:12px 16px;color:#e2e8f0">${nights}</td>
    </tr>
    <tr style="border-bottom:1px solid #243044">
      <td style="padding:12px 16px;color:#9aa6b2;font-size:13px">Check-in</td>
      <td style="padding:12px 16px;color:#e2e8f0">${new Date(booking.check_in).toLocaleString()}</td>
    </tr>
    <tr style="border-bottom:1px solid #243044">
      <td style="padding:12px 16px;color:#9aa6b2;font-size:13px">Check-out</td>
      <td style="padding:12px 16px;color:#e2e8f0">${new Date(booking.check_out).toLocaleString()}</td>
    </tr>
    <tr>
      <td style="padding:12px 16px;color:#9aa6b2;font-size:13px">Amount</td>
      <td style="padding:12px 16px;color:#d8a84f;font-weight:700">$${Number(booking.amount || 0).toFixed(2)}</td>
    </tr>
  </table>

  <p style="color:#9aa6b2;text-align:center;font-size:13px;margin:0">
    We look forward to welcoming you back.
  </p>

</div></body></html>`,
  });
}

/**
 * Live verification request — sent to the guest when staff initiates identity check.
 */
export async function sendVerificationRequest({ guest, hotel }) {
  const link = `${config.clientUrl}/guest/${guest.access_token}`;
  await send({
    hotelId: hotel.id,
    to: guest.email,
    subject: `${hotel.name} — identity verification needed`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0d1b2a;padding:32px">
<div style="max-width:480px;margin:auto;background:#162235;border-radius:16px;padding:32px;text-align:center">
  <h2 style="color:#d8a84f;margin:0 0 12px">Identity verification</h2>
  <p style="color:#9aa6b2;margin:0 0 20px">
    The reception team is ready to check you in.<br>
    Please take a live selfie to verify your identity.
  </p>
  <a href="${link}"
     style="display:inline-block;background:#d8a84f;color:#0d1b2a;padding:14px 28px;border-radius:8px;font-weight:700;text-decoration:none">
    Verify Now →
  </a>
</div></body></html>`,
  });
}
