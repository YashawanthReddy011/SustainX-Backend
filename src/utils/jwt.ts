import jwt from "jsonwebtoken";

import { env } from "../config/env";

export type TokenPayload = {
  id: string;

  role:
    | "STUDENT"
    | "COMMUNITY"
    | "ADMIN";
};

export function signToken(
  payload: TokenPayload
) {
  return jwt.sign(
    payload,
    env.jwtSecret,
    {
      expiresIn: "2h"
    }
  );
}

export function verifyToken(
  token: string
) {
  return jwt.verify(
    token,
    env.jwtSecret
  ) as TokenPayload;
}
