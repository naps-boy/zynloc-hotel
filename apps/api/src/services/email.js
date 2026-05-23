import { config } from "../config.js";

// ── Resend HTTP transport ──────────────────────────────────────────────────────
// Docs: https://resend.com/docs/api-reference/emails/send-email
// Set RESEND_API_KEY in Render env vars.
// MAIL_FROM must be an address from a Resend-verified domain, OR use
// "onboarding@resend.dev" (Resend's shared test sender — only delivers to
// the email registered on your Resend account; fine for testing).

async function send({ to, subject, html, attachments = [] }) {
  if (!config.resendApiKey) {
    console.log(`[Email disabled — set RESEND_API_KEY] To: ${to}  Subject: ${subject}`);
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
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    // Log but don't crash the request — email failure shouldn't block the booking
    console.error(`[Email error] ${resp.status} ${resp.statusText}: ${body}`);
    return;
  }

  const { id } = await resp.json();
  console.log(`[Email sent] id=${id}  to=${to}  subject="${subject}"`);
}

// ─── Booking confirmation + profile completion link ───────────────────────────
export async function sendBookingConfirmation({ guest, hotel, booking, qr }) {
  const guestLink = `${config.clientUrl}/guest/${qr.token}`;
  await send({
    to: guest.email,
    subject: `Your booking at ${hotel.name} is confirmed`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0d1b2a;color:#e2e8f0;padding:32px">
<div style="max-width:520px;margin:auto;background:#162235;border-radius:16px;padding:32px">
  <h1 style="color:#d8a84f;margin:0 0 8px">Welcome to ${hotel.name}</h1>
  <p style="color:#9aa6b2;margin:0 0 24px">Your stay is confirmed</p>

  <table style="width:100%;border-collapse:collapse;margin:0 0 24px">
    <tr><td style="padding:8px 0;color:#9aa6b2">Guest</td><td style="color:#e2e8f0;font-weight:bold">${guest.name}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Room</td><td style="color:#e2e8f0;font-weight:bold">${booking.room_number}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Check-in</td><td style="color:#e2e8f0">${new Date(booking.check_in).toLocaleString()}</td></tr>
    <tr><td style="padding:8px 0;color:#9aa6b2">Check-out</td><td style="color:#e2e8f0">${new Date(booking.check_out).toLocaleString()}</td></tr>
    ${booking.special_notes ? `<tr><td style="padding:8px 0;color:#9aa6b2">Notes</td><td style="color:#e2e8f0">${booking.special_notes}</td></tr>` : ""}
  </table>

  <div style="background:#0d1b2a;border-radius:12px;padding:20px;margin:0 0 24px;border:1px solid #243044">
    <h2 style="color:#d8a84f;margin:0 0 8px;font-size:16px">Action required before arrival</h2>
    <p style="color:#9aa6b2;margin:0 0 16px;font-size:14px">Please complete your guest profile so we can prepare for your arrival. This takes 2 minutes.</p>
    <a href="${guestLink}" style="display:inline-block;background:#d8a84f;color:#0d1b2a;padding:14px 28px;border-radius:8px;font-weight:bold;text-decoration:none;font-size:16px">Complete My Profile →</a>
  </div>

  <p style="color:#9aa6b2;font-size:12px">Keep this link — it is your access key for the entire stay. Reception: ${hotel.reception_phone || "See hotel website"}</p>
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
