import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";

export const LOGIN_OTP_TTL_MS = 10 * 60 * 1000;
export const LOGIN_OTP_MAX_ATTEMPTS = 5;

export function createLoginOtp() {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashLoginOtp(challengeId: string, code: string) {
  return createHmac("sha256", env.jwtSecret)
    .update(`${challengeId}:${code}`)
    .digest("hex");
}

export function loginOtpMatches(challengeId: string, code: string, storedHash: string) {
  const expected = Buffer.from(hashLoginOtp(challengeId, code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return expected.length === stored.length && timingSafeEqual(expected, stored);
}
