import { config } from "../config.js";

// ── Resend HTTP transport ──────────────────────────────────────────────────────
// Docs: https://resend.com/docs/api-reference/emails/send-email
// Set RESEND_API_KEY in Render env vars.
// MAIL_FROM must be an address from a Resend-verified domain, OR use
// "onboarding@resend.dev" (Resend's shared test sender — only delivers to
// the email registered on your Resend account; fine for testing).

async function send({ to, subject, html, attachments = [] }) {
  const key = config.resendApiKey;
  console.log(`[Email] send() called — to=${JSON.stringify(to)} subject="${subject}" apiKey=${key ? key.slice(0,8)+"…" : "NOT SET"}`);

  if (!key) {
    console.log(`[Email] RESEND_API_KEY is not set — skipping send`);
    return;
  }

  const payload = {
    from: config.mailFrom,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };

  if (attachments.length) {
    payload.attachments = attachments.map(a => ({
      filename: a.filename,
      content: a.content,   // base64 string
    }));
    console.log(`[Email] attaching ${attachments.length} file(s): ${attachments.map(a => a.filename).join(", ")}`);
  }

  console.log(`[Email] POSTing to Resend — from="${payload.from}" to=${JSON.stringify(payload.to)}`);

  let resp;
  try {
    resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (fetchErr) {
    console.error(`[Email] fetch() threw:`, fetchErr);
    return;
  }

  const bodyText = await resp.text();
  console.log(`[Email] Resend response ${resp.status} ${resp.statusText}: ${bodyText}`);

  if (!resp.ok) {
    // Log but don't crash the request — email failure shouldn't block the booking
    console.error(`[Email error] Resend rejected the request — status=${resp.status}`);
    return;
  }

  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { parsed = {}; }
  console.log(`[Email sent] id=${parsed.id}  to=${JSON.stringify(to)}  subject="${subject}"`);
}

// ─── Booking confirmation ─────────────────────────────────────────────────────
// managerEmail: hotel manager's email address (used as `to` while onboarding@resend.dev
// is active, since Resend's shared sender only delivers to the account owner's email).
// Once a custom domain is verified on Resend, switch `to` back to guest.email.
export async function sendBookingConfirmation({ guest, hotel, booking, qr, managerEmail }) {
  const guestLink = `${config.clientUrl}/guest/${qr.token}`;
  const recipient = managerEmail || guest.email;
  await send({
    to: recipient,
    subject: `New booking: ${guest.name} → ${hotel.name} (Room ${booking.room_number})`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0d1b2a;color:#e2e8f0;padding:32px">
<div style="max-width:520px;margin:auto;background:#162235;border-radius:16px;padding:32px">
  <h1 style="color:#d8a84f;margin:0 0 8px">New booking — ${hotel.name}</h1>
  <p style="color:#9aa6b2;margin:0 0 24px;font-size:13px">Share the guest profile link below with your guest so they can complete check-in.</p>

  <table style="width:100%;border-collapse:collapse;margin:0 0 24px">
    <tr><td style="padding:8px 0;color:#9aa6b2">Guest</td><td style="color:#e2e8f0;font-weight:bold">${guest.name}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Guest email</td><td style="color:#e2e8f0">${guest.email}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Room</td><td style="color:#e2e8f0;font-weight:bold">${booking.room_number}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Check-in</td><td style="color:#e2e8f0">${new Date(booking.check_in).toLocaleString()}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Check-out</td><td style="color:#e2e8f0">${new Date(booking.check_out).toLocaleString()}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Amount</td><td style="color:#d8a84f;font-weight:bold">$${Number(booking.amount || 0).toFixed(2)}</td></tr>
    ${booking.special_notes ? `<tr><td style="padding:8px 0;color:#9aa6b2">Notes</td><td style="color:#e2e8f0">${booking.special_notes}</td></tr>` : ""}
  </table>

  <div style="background:#0d1b2a;border-radius:12px;padding:20px;margin:0 0 24px;border:1px solid #243044">
    <h2 style="color:#d8a84f;margin:0 0 8px;font-size:16px">Guest profile link</h2>
    <p style="color:#9aa6b2;margin:0 0 16px;font-size:14px">Forward this link to ${guest.name} — it opens their guest app and lets them complete their profile before arrival.</p>
    <a href="${guestLink}" style="display:inline-block;background:#d8a84f;color:#0d1b2a;padding:14px 28px;border-radius:8px;font-weight:bold;text-decoration:none;font-size:16px">Open Guest App →</a>
  </div>

  <p style="color:#9aa6b2;font-size:11px">Guest link: ${guestLink}</p>
</div></body></html>
    `,
    attachments: [
      {
        filename: "zynloc-access-qr.png",
        content: qr.qr_data_url.split(",")[1],
      },
    ],
  });
}

// ─── Checkout receipt ─────────────────────────────────────────────────────────
export async function sendCheckoutReceipt({ guest, hotel, booking }) {
  const nights = Math.max(1, Math.ceil((new Date(booking.check_out) - new Date(booking.check_in)) / 86400000));
  await send({
    to: guest.email,
    subject: `Thank you for staying at ${hotel.name}`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0d1b2a;color:#e2e8f0;padding:32px">
<div style="max-width:520px;margin:auto;background:#162235;border-radius:16px;padding:32px">
  <h1 style="color:#d8a84f;margin:0 0 8px">Thank you, ${guest.name}</h1>
  <p style="color:#9aa6b2;margin:0 0 24px">We hope you enjoyed your stay</p>

  <table style="width:100%;border-collapse:collapse;margin:0 0 24px">
    <tr><td style="padding:8px 0;color:#9aa6b2">Room</td><td style="color:#e2e8f0">${booking.room_number}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Nights</td><td style="color:#e2e8f0">${nights}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Check-in</td><td style="color:#e2e8f0">${new Date(booking.check_in).toLocaleString()}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Check-out</td><td style="color:#e2e8f0">${new Date(booking.check_out).toLocaleString()}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Amount</td><td style="color:#d8a84f;font-weight:bold">$${Number(booking.amount || 0).toFixed(2)}</td></tr>
  </table>
</div></body></html>
    `,
  });
}

// ─── Live verification request ────────────────────────────────────────────────
export async function sendVerificationRequest({ guest, hotel }) {
  const link = `${config.clientUrl}/guest/${guest.access_token}`;
  await send({
    to: guest.email,
    subject: `${hotel.name} — identity verification needed`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0d1b2a;padding:32px">
<div style="max-width:480px;margin:auto;background:#162235;border-radius:16px;padding:32px;text-align:center">
  <h2 style="color:#d8a84f">Identity verification</h2>
  <p style="color:#9aa6b2">The reception team is ready to check you in. Please take a live selfie to verify your identity.</p>
  <a href="${link}" style="display:inline-block;background:#d8a84f;color:#0d1b2a;padding:14px 28px;border-radius:8px;font-weight:bold;text-decoration:none;margin-top:16px">Verify Now →</a>
</div></body></html>
    `,
  });
}
