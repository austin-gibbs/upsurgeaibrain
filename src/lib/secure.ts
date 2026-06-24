import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Use for secrets (bearer tokens, webhook
 * digests) so response timing never reveals how much of the value matched.
 * Returns false on length mismatch without leaking via early return on content.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still do a comparison against a same-length buffer to keep timing uniform.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Extract and constant-time-verify a `Bearer <token>` Authorization header. */
export function bearerMatches(header: string | null, expected: string | undefined): boolean {
  if (!expected) return false;
  if (!header) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqualStr(header.slice(prefix.length), expected);
}
