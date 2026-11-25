import { randomUUID } from "node:crypto";
import { getCollection } from "../config/db";
import { createOneTimeToken } from "../utils/oneTimeToken";
import { hashPassword } from "../utils/password";
import type { Role } from "../types";

export async function createPasswordAccount(input: {
  name: string;
  email: string;
  password: string;
  role: Role;
}) {
  const email = input.email.trim().toLowerCase();
  const { token, tokenHash } = createOneTimeToken();
  const user = {
    _id: randomUUID(),
    name: input.name.trim(),
    email,
    role: input.role,
    passwordHash: await hashPassword(input.password),
    emailVerified: false,
    tokenVersion: 0,
    verificationTokenHash: tokenHash,
    verificationTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    impactPoints: 0,
    status: "ACTIVE",
    createdAt: new Date(),
  };

  await (await getCollection("User")).insertOne(user);
  return { user, verificationToken: token };
}
