import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";

import { env } from "../config/env";

export type TokenPayload = {
  id: string;
  version: number;
  jti: string;
  exp: number;
};

export function signToken(payload: Pick<TokenPayload, "id" | "version">) {
  return jwt.sign(
    payload,
    env.jwtSecret,
    {
      algorithm: "HS256",
      expiresIn: "2h",
      jwtid: randomUUID(),
      issuer: "sustainx-api",
      audience: "sustainx-app",
    }
  );
}

export function verifyToken(
  token: string
) {
  const payload = jwt.verify(token, env.jwtSecret, {
    algorithms: ["HS256"],
    issuer: "sustainx-api",
    audience: "sustainx-app",
  });
  if (typeof payload === "string" || typeof payload.id !== "string" || typeof payload.version !== "number" || typeof payload.jti !== "string" || typeof payload.exp !== "number") {
    throw new Error("Invalid token payload");
  }
  return payload as TokenPayload;
}
