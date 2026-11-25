import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";

const WORK_FACTOR = 12;
const DUMMY_HASH = bcrypt.hash(prehash("sustainx-invalid-user-password"), WORK_FACTOR);

function prehash(password: string) {
  return createHash("sha256").update(password, "utf8").digest("base64");
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(prehash(password), WORK_FACTOR);
}

export async function verifyPassword(password: string, passwordHash?: string): Promise<boolean> {
  const hash = passwordHash ?? await DUMMY_HASH;
  try {
    return await bcrypt.compare(prehash(password), hash);
  } catch {
    return false;
  }
}
