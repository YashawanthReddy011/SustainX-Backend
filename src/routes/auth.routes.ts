import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import {
  forgotPassword,
  login,
  logout,
  me,
  register,
  resendVerification,
  resetPassword,
  verifyEmail,
  verifyLoginCode,
} from "../controllers/auth.controller";
import { auth } from "../middleware/auth";
import { authRateLimit } from "../middleware/authRateLimit";
import { validate } from "../middleware/validate";

const router = Router();
const emailSchema = z.string().trim().email().max(254);
const emailRateLimitIdentity = (req: Request) =>
  typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
const passwordSchema = z.string().min(12).max(128);
const returnPathSchema = z.string().max(2048).refine((value) => {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  try {
    return new URL(value, "https://sustainx.invalid").origin === "https://sustainx.invalid";
  } catch {
    return false;
  }
}).optional();

router.post(
  "/register",
  authRateLimit(5, 15 * 60 * 1000),
  validate(z.object({ name: z.string().trim().min(2).max(100), email: emailSchema, password: passwordSchema })),
  register
);
router.post(
  "/login",
  authRateLimit(5, 15 * 60 * 1000, emailRateLimitIdentity),
  validate(z.object({
    email: emailSchema,
    password: z.string().min(1).max(128),
    portal: z.enum(["STUDENT", "DASHBOARD", "ADMIN"]).optional().default("STUDENT"),
    securityKey: z.string().max(128).optional().default(""),
  })),
  login
);
router.post(
  "/login/verify-code",
  authRateLimit(10, 15 * 60 * 1000, emailRateLimitIdentity),
  validate(z.object({ email: emailSchema, challengeId: z.string().min(32).max(128), code: z.string().regex(/^\d{6}$/) })),
  verifyLoginCode
);
router.post("/verify-email", authRateLimit(10, 15 * 60 * 1000), validate(z.object({ token: z.string().min(32).max(128) })), verifyEmail);
router.post("/resend-verification", authRateLimit(3, 15 * 60 * 1000), validate(z.object({ email: emailSchema, next: returnPathSchema })), resendVerification);
router.post("/forgot-password", authRateLimit(3, 15 * 60 * 1000), validate(z.object({ email: emailSchema })), forgotPassword);
router.post(
  "/reset-password",
  authRateLimit(5, 15 * 60 * 1000),
  validate(z.object({ token: z.string().min(32).max(128), password: passwordSchema })),
  resetPassword
);
router.get("/me", auth, me);
router.post("/logout", auth, logout);

export default router;
