import { NextFunction, Request, Response } from "express";
import { getCollection } from "../config/db";
import { verifyToken } from "../utils/jwt";
import type { Role } from "../types";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: Role };
      authToken?: { id: string; expiresAt: Date };
    }
  }
}

export async function resolveTokenUser(token: string) {
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return null;
  }

  const revoked = await (await getCollection("RevokedToken")).findOne({ _id: payload.jti });
  if (revoked) return null;

  const user = await (await getCollection("User")).findOne(
    { _id: payload.id },
    { projection: { role: 1, status: 1, emailVerified: 1, tokenVersion: 1 } }
  );
  if (!user || user.status !== "ACTIVE" || user.emailVerified !== true) return null;
  if (Number(user.tokenVersion ?? 0) !== payload.version) return null;
  if (!["STUDENT", "COMMUNITY", "ADMIN"].includes(user.role)) return null;

  return {
    user: { id: String(user._id), role: user.role as Role },
    token: { id: payload.jti, expiresAt: new Date(payload.exp * 1000) },
  };
}

export async function auth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const resolved = await resolveTokenUser(header.slice(7));
  if (!resolved) return res.status(401).json({ error: "Invalid, expired, or revoked token" });
  req.user = resolved.user;
  req.authToken = resolved.token;
  return next();
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const resolved = await resolveTokenUser(header.slice(7));
    if (resolved) {
      req.user = resolved.user;
      req.authToken = resolved.token;
    }
  }
  return next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
}

export async function revokeToken(token: { id: string; expiresAt: Date }) {
  await (await getCollection("RevokedToken")).updateOne(
    { _id: token.id },
    { $setOnInsert: { expiresAt: token.expiresAt, revokedAt: new Date() } },
    { upsert: true }
  );
}

export async function ensureAuthIndexes() {
  const users = await getCollection("User");
  await users.createIndex({ email: 1 }, { unique: true, name: "user_email_unique" });
  await users.createIndex({ verificationTokenHash: 1 }, { sparse: true, name: "verification_token_hash" });
  await users.createIndex({ passwordResetTokenHash: 1 }, { sparse: true, name: "password_reset_token_hash" });
  await (await getCollection("RevokedToken")).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "revoked_token_ttl" });
  await (await getCollection("AuthRateLimit")).createIndex({ resetAt: 1 }, { expireAfterSeconds: 0, name: "auth_rate_limit_ttl" });
}
