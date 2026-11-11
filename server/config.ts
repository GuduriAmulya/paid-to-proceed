import "dotenv/config";

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

export const config = {
  // In `npm run dev` the API always runs on 8787 behind the Vite proxy (PORT belongs to Vite there).
  port: Number(process.env.npm_lifecycle_event === "dev" ? env("API_PORT", "8787") : env("PORT", "8787")),
  isProd: env("NODE_ENV") === "production",

  // PayPal (sandbox by default)
  paypalClientId: env("PAYPAL_CLIENT_ID"),
  paypalClientSecret: env("PAYPAL_CLIENT_SECRET"),
  paypalEnv: env("PAYPAL_ENVIRONMENT", "SANDBOX").toUpperCase() === "PRODUCTION" ? "PRODUCTION" : "SANDBOX",
  paypalWebhookId: env("PAYPAL_WEBHOOK_ID"),

  // Who gets invoiced / paid in the demo (sandbox personal accounts)
  demoClientEmail: env("DEMO_CLIENT_EMAIL", "client@example.com"),
  demoSubcontractorEmail: env("DEMO_SUBCONTRACTOR_EMAIL", "subcontractor@example.com"),

  // Claude
  anthropicModel: env("ANTHROPIC_MODEL", "claude-opus-5-5"),
  hasAnthropicKey: Boolean(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN")),

  dataFile: env("DATA_FILE", "data/db.json"),
};

export const paypalBaseUrl =
  config.paypalEnv === "PRODUCTION" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export const hasPayPal = Boolean(config.paypalClientId && config.paypalClientSecret);
