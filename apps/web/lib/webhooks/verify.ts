import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** GitHub: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, raw body) hex. */
export function verifyGitHub(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(signatureHeader.slice("sha256=".length), expected);
}

/** Vercel: x-vercel-signature = HMAC-SHA1(secret, raw body) hex. */
export function verifyVercel(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha1", secret).update(rawBody).digest("hex");
  return safeEqualHex(signatureHeader, expected);
}
