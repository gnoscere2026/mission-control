import { timingSafeEqual } from "node:crypto";

// Constant-time shared-secret check (auth-lite, ARCHITECTURE §4: a real session,
// never a query param; the secret comparison still shouldn't leak timing).
export function verifySecret(candidate: string, expected: string | undefined): boolean {
  if (!expected || expected.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
