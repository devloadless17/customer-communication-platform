import "server-only";

import bcrypt from "bcryptjs";

// 10 rounds: ~100ms on dev hardware. Higher hardens against offline attacks
// at the cost of login latency; 10 is the standard sweet spot for B2B apps.
const COST = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
