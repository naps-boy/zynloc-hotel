import nodemailer from "nodemailer";
import { config } from "../config.js";

function getTransport() {
  if (!config.smtp.host) return null;
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined
  });
}

async function send(options) {
  const transport = getTransport();
  if (!transport) {
    console.log(`[Email disabled] To: ${options.to}  Subject: ${options.subject}`);
    return;
  }
  await transport.sendMail({ from: config.mailFrom, ...options });
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
        encoding: "base64"
      }
    ]
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
    <tr><td style="padding:8px 0;color:#9aa6b2">Amount</td><td style="color:#d8a84f;font-weight:bold">$${Number(booking.amount).toFixed(2)}</td></tr>
  </table>

  <p style="color:#9aa6b2;font-size:13px">We would love to hear about your experience. <a href="mailto:${hotel.reception_phone ? "" : "reviews@zynloc.com"}" style="color:#d8a84f">Leave a review</a></p>
</div></body></html>
    `
  });
}

// ─── Live verification request (push via email fallback) ─────────────────────
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
    `
  });
}
