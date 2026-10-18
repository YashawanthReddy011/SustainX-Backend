import "dotenv/config";

export const env = {
  port: Number(process.env.PORT || 5000),

  clientUrl:
    process.env.CLIENT_URL ||
    "http://localhost:3000",

  adminUrl:
    process.env.ADMIN_URL ||
    "http://localhost:3001",

  jwtSecret:
    process.env.JWT_SECRET ||
    "development-secret"
};
