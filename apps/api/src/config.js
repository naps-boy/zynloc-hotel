import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  clientUrl: process.env.CLIENT_URL || "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || "development-only-secret",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  stripePriceId: process.env.STRIPE_PRICE_ID || "",
  // Platform-level Brevo credentials — used as fallback for hotels without their own SMTP config
  brevoApiKey:     process.env.BREVO_API_KEY     || "",
  brevoSenderEmail: process.env.BREVO_SENDER_EMAIL || "mehnapoelionfuh@11297397.brevosend.com",
  brevoSenderName:  process.env.BREVO_SENDER_NAME  || "Zynloc Hotel",
};

export function requireEnv() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
}
