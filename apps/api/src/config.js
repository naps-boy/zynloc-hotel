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
  mailFrom: process.env.MAIL_FROM || "Zynloc Hotel <onboarding@resend.dev>",
  resendApiKey: process.env.RESEND_API_KEY || "",
};

export function requireEnv() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
}
