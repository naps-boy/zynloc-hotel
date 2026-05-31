import nodemailer from "nodemailer";
import { query } from "../db/pool.js";
import { config } from "../config.js";

// ── SMTP config lookup ────────────────────────────────────────────────────────

export async function getHotelSmtpConfig(hotelId) {
  // 1. Try hotel-specific default config
  const { rows } = await query(
    "SELECT * FROM smtp_configs WHERE hotel_id = $1 AND is_default = TRUE LIMIT 1",
    [hotelId]
  );
  if (rows[0]) return rows[0];

  // 2. Env-var override (BREVO_API_KEY set on Render)
  if (config.brevoApiKey) {
    console.log(`[Email:getHotelSmtpConfig] hotel ${hotelId} has no config — using env BREVO_API_KEY`);
    return {
      id:          "platform-brevo-env",
      provider:    "brevo",
      email:       config.brevoSenderEmail,
      sender_name: config.brevoSenderName,
      smtp_pass:   config.brevoApiKey,
      is_default:  true,
    };
  }

  // 3. Last resort — reuse the platform's known-good default Brevo config directly.
  //    Query for is_default=TRUE Brevo configs across all hotels, oldest first
  //    (the testfix/platform hotel's config is oldest and guaranteed to work).
  const { rows: anyRows } = await query(
    "SELECT * FROM smtp_configs WHERE provider = 'brevo' AND is_default = TRUE ORDER BY created_at LIMIT 1"
  );
  if (anyRows[0]) {
    console.log(`[Email:getHotelSmtpConfig] hotel ${hotelId} has no config — sharing platform Brevo config (hotel ${anyRows[0].hotel_id})`);
    return anyRows[0];
  }

  console.warn(`[Email:getHotelSmtpConfig] hotel ${hotelId} — no SMTP config found anywhere`);
  return null;
}

// ── Provider: Brevo HTTP API (port 443 — works on Render free tier) ──────────

async function sendViaBrevo(cfg, mailOpts) {
  // cfg.smtp_pass holds the Brevo API key — trim to strip any accidental whitespace
  const apiKey = (cfg.smtp_pass || "").trim();
  console.log(`[Brevo] key_len=${apiKey.length} key_prefix="${apiKey.substring(0, 20)}" sender=${cfg.email}`);

  if (!apiKey) throw new Error("Brevo API key is empty");

  const to = Array.isArray(mailOpts.to)
    ? mailOpts.to.map(e => ({ email: e.trim() }))
    : [{ email: mailOpts.to }];

  // Primary sender — professional domain
  const primarySender  = { name: "Zynloc Hotel", email: "zynloc@veltaforge.com" };
  // Fallback sender — verified Gmail address
  const fallbackSender = { name: "Zynloc Hotel", email: "mehnapoelionfuh@gmail.com" };

  const body = {
    sender:      primarySender,
    to,
    subject:     mailOpts.subject,
    htmlContent: mailOpts.html,
    headers: {
      "List-Unsubscribe": `<mailto:${primarySender.email}?subject=unsubscribe>`,
      "X-Mailer":         "Zynloc Hotel Platform",
    },
  };

  if (mailOpts.attachments?.length) {
    body.attachment = mailOpts.attachments.map(a => ({
      name:    a.filename,
      content: Buffer.isBuffer(a.content)
        ? a.content.toString("base64")
        : a.content,   // already base64
    }));
  }

  let res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method:  "POST",
    headers: {
      "api-key":      apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // If primary veltaforge.com sender fails (domain not yet verified), fall back to Gmail
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    console.log(`[Brevo] HTTP ${res.status} response:`, JSON.stringify(errBody));
    if (errBody?.message?.includes("sender") || res.status === 400) {
      console.log("[Email] Primary sender failed, using fallback Gmail sender");
      body.sender  = fallbackSender;
      body.headers["List-Unsubscribe"] = `<mailto:${fallbackSender.email}?subject=unsubscribe>`;
      res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method:  "POST",
        headers: {
          "api-key":      apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } else {
      throw new Error(errBody.message || `Brevo error ${res.status}`);
    }
  }

  const json = await res.json().catch(() => ({}));
  console.log(`[Brevo] HTTP ${res.status} response:`, JSON.stringify(json));
  if (!res.ok) throw new Error(json.message || `Brevo error ${res.status}`);
  console.log(`[Email] Brevo sent — messageId=${json.messageId}`);
  return { messageId: json.messageId };
}

// ── Provider: Gmail service / custom SMTP (nodemailer) ───────────────────────

function createSmtpTransporter(cfg) {
  if (cfg.provider === "gmail") {
    // nodemailer built-in gmail shorthand — uses port 465 SSL automatically
    return nodemailer.createTransport({
      service: "gmail",
      auth: { user: cfg.smtp_user || cfg.email, pass: cfg.smtp_pass },
    });
  }

  // Custom SMTP — full config with IPv4 enforcement and generous timeouts
  return nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   cfg.smtp_port,
    family: 4,             // Force IPv4 — Render free tier blocks IPv6 egress
    secure: cfg.smtp_port === 465,
    auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
    tls:  { rejectUnauthorized: false },
    connectionTimeout: 30_000,
    greetingTimeout:   10_000,
    socketTimeout:     45_000,
  });
}

// ── Test email ────────────────────────────────────────────────────────────────

const testHtml = (cfg) => `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0d1b2a;color:#e2e8f0;padding:32px">
<div style="max-width:480px;margin:auto;background:#162235;border-radius:16px;padding:32px;text-align:center">
  <h2 style="color:#d8a84f;margin:0 0 12px">Email delivery verified ✓</h2>
  <p style="color:#9aa6b2;margin:0">Your email configuration is working correctly.<br>
  Zynloc Hotel will send guest emails from this address.</p>
  <p style="color:#9aa6b2;margin:24px 0 0;font-size:12px">
    Provider: <strong style="color:#d8a84f">${cfg.provider || "custom"}</strong> ·
    Sender: ${cfg.email}
  </p>
</div></body></html>`;

export async function sendTestEmail(smtpCfg, toAddress) {
  const mailOpts = {
    from:    `"${smtpCfg.sender_name}" <${smtpCfg.email}>`,
    to:      toAddress,
    subject: "Zynloc Hotel — email delivery test",
    html:    testHtml(smtpCfg),
  };

  // ── Brevo HTTP path ──────────────────────────────────────────────────────
  if (smtpCfg.provider === "brevo") {
    try {
      const r = await sendViaBrevo(smtpCfg, mailOpts);
      return { ok: true, messageId: r.messageId };
    } catch (err) {
      console.error("[Email] Brevo test failed:", err.message);
      return { ok: false, error: err.message };
    }
  }

  // ── Gmail / custom SMTP path ─────────────────────────────────────────────
  const isConnErr = c =>
    ["ECONNECTION", "ETIMEDOUT", "ENETUNREACH", "ECONNREFUSED"].includes(c);

  try {
    const info = await createSmtpTransporter(smtpCfg).sendMail(mailOpts);
    console.log(`[Email] Test sent — messageId=${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error(
      `[Email] Test failed on port ${smtpCfg.smtp_port}: [${err.code}] ${err.message}`
    );
    // Auto-retry custom SMTP on port 465 when 587 fails with a TCP/routing error
    if (smtpCfg.provider === "custom" && smtpCfg.smtp_port === 587 && isConnErr(err.code)) {
      console.log("[Email] Retrying on port 465…");
      try {
        const info = await createSmtpTransporter({ ...smtpCfg, smtp_port: 465 }).sendMail(mailOpts);
        console.log(`[Email] Test sent via fallback 465 — messageId=${info.messageId}`);
        return { ok: true, messageId: info.messageId };
      } catch (err2) {
        console.error(`[Email] Fallback 465 also failed: [${err2.code}] ${err2.message}`);
        return { ok: false, error: err2.message, code: err2.code };
      }
    }
    return { ok: false, error: err.message, code: err.code };
  }
}

// ── Internal send helper ──────────────────────────────────────────────────────

async function send({ hotelId, to, subject, html, attachments = [] }) {
  console.log(`[Email:send] ENTRY — hotelId=${hotelId} to=${Array.isArray(to) ? to.join(",") : to} subject="${subject}"`);

  const smtpCfg = await getHotelSmtpConfig(hotelId);
  if (!smtpCfg) {
    console.warn(`[Email:send] No SMTP config for hotel ${hotelId} — skipping "${subject}"`);
    return null;
  }
  console.log(`[Email:send] Found config id=${smtpCfg.id} provider=${smtpCfg.provider} sender=${smtpCfg.email} key_len=${smtpCfg.smtp_pass?.length ?? 0}`);

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

  try {
    if (smtpCfg.provider === "brevo") {
      const r = await sendViaBrevo(smtpCfg, mailOpts);
      console.log(`[Email:send] SUCCESS via Brevo — messageId=${r.messageId}`);
      return r.messageId;
    } else {
      const info = await createSmtpTransporter(smtpCfg).sendMail(mailOpts);
      console.log(`[Email:send] SUCCESS via SMTP — messageId=${info.messageId}`);
      return info.messageId;
    }
  } catch (err) {
    // Email failure must never block a booking/checkin operation
    console.error(`[Email:send] FAILED to send "${subject}" to ${mailOpts.to}:`, err.message);
    return null;
  }
}

// ── Transactional emails ──────────────────────────────────────────────────────

export async function sendBookingConfirmation({ guest, hotel, booking, qr, hotelId }) {
  console.log(`[Email:sendBookingConfirmation] ENTRY — guest=${guest?.email} hotel=${hotel?.name} hotelId=${hotelId}`);
  const guestLink = `${config.clientUrl}/guest/${qr.token}`;
  const messageId = await send({
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
  console.log(`[Email:sendBookingConfirmation] DONE — messageId=${messageId}`);
  return messageId;
}

export async function sendCheckoutReceipt({ guest, hotel, booking }) {
  console.log(`[Email:sendCheckoutReceipt] ENTRY — guest=${guest?.email} hotel=${hotel?.name}`);
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
  <p style="color:#9aa6b2;text-align:center;font-size:13px;margin:0">We look forward to welcoming you back.</p>
</div></body></html>`,
  });
}

export async function sendPasswordResetEmail({ staffEmail, staffName, hotelId, resetLink }) {
  console.log(`[Email:sendPasswordResetEmail] ENTRY — staffEmail=${staffEmail} hotelId=${hotelId}`);
  // Try ALL smtp configs for the hotel (default first, then any remaining).
  // This handles the case where the default config has a stale/revoked key —
  // we fall through to the next config automatically.
  console.log(`[PasswordReset] Looking up all SMTP configs for hotel ${hotelId}`);

  const { rows: allConfigs } = await query(
    "SELECT * FROM smtp_configs WHERE hotel_id = $1 ORDER BY is_default DESC, created_at DESC",
    [hotelId]
  );

  if (!allConfigs.length) {
    console.error(`[PasswordReset] FATAL: no SMTP configs at all for hotel ${hotelId} — cannot send to ${staffEmail}`);
    return;
  }

  console.log(`[PasswordReset] Found ${allConfigs.length} SMTP config(s)`);

  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0d1b2a;color:#e2e8f0;padding:32px">
<div style="max-width:480px;margin:auto;background:#162235;border-radius:16px;padding:32px;text-align:center">
  <h2 style="color:#d8a84f;margin:0 0 12px">Password Reset</h2>
  <p style="color:#9aa6b2;margin:0 0 20px">Hi ${staffName},<br>
  Click below to reset your Zynloc Hotel password. This link expires in 1 hour.</p>
  <a href="${resetLink}"
     style="display:inline-block;background:#d8a84f;color:#0d1b2a;padding:14px 28px;border-radius:8px;font-weight:700;text-decoration:none">
    Reset Password →
  </a>
  <p style="color:#4a5568;font-size:11px;margin:20px 0 0">
    If you didn't request this, ignore this email.<br>${resetLink}
  </p>
</div></body></html>`;

  for (let i = 0; i < allConfigs.length; i++) {
    const smtpCfg = allConfigs[i];
    const label = `config[${i}] id=${smtpCfg.id} provider=${smtpCfg.provider} sender=${smtpCfg.email} is_default=${smtpCfg.is_default}`;
    console.log(`[PasswordReset] Trying ${label}`);

    const mailOpts = {
      from:    `"${smtpCfg.sender_name}" <${smtpCfg.email}>`,
      to:      staffEmail,
      subject: "Your password reset link",
      html,
    };

    try {
      if (smtpCfg.provider === "brevo") {
        const result = await sendViaBrevo(smtpCfg, mailOpts);
        console.log(`[PasswordReset] SUCCESS via ${label} — messageId=${result.messageId}`);
        return result.messageId;
      } else {
        const info = await createSmtpTransporter(smtpCfg).sendMail(mailOpts);
        console.log(`[PasswordReset] SUCCESS via ${label} — messageId=${info.messageId}`);
        return info.messageId;
      }
    } catch (err) {
      const hasMore = i < allConfigs.length - 1;
      console.error(`[PasswordReset] FAILED via ${label}: ${err.message}${hasMore ? " — trying next config" : " — no more configs"}`);
    }
  }

  console.error(`[PasswordReset] All ${allConfigs.length} SMTP config(s) exhausted. Email NOT sent to ${staffEmail}.`);
}

export async function sendVerificationRequest({ guest, hotel }) {
  console.log(`[Email:sendVerificationRequest] ENTRY — guest=${guest?.email} hotel=${hotel?.name}`);
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
