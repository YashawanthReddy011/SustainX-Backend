import "dotenv/config";

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 5000),
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS || 0),

  clientUrl:
    process.env.CLIENT_URL ||
    "http://localhost:3000",

  adminUrl:
    process.env.ADMIN_URL ||
    "http://localhost:3001",

  jwtSecret:
    process.env.JWT_SECRET ||
    "development-secret",

  authEmailApiKey: process.env.AUTH_EMAIL_API_KEY || "",
  authEmailFrom: process.env.AUTH_EMAIL_FROM || process.env.SMTP_USER || "",
  authEmailApiUrl: process.env.AUTH_EMAIL_API_URL || "https://api.resend.com/emails",
  smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpSecure: process.env.SMTP_SECURE !== "false",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  dashboardAccessKey: process.env.DASHBOARD_ACCESS_KEY || "",
  adminAccessKey: process.env.ADMIN_ACCESS_KEY || "",
};

if (!Number.isSafeInteger(env.trustProxyHops) || env.trustProxyHops < 0) {
  throw new Error("TRUST_PROXY_HOPS must be a non-negative integer.");
}

if (env.nodeEnv === "production" && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error("Set JWT_SECRET to a random value with at least 32 characters in production.");
}
