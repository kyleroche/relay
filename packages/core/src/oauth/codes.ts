/**
 * Pure helpers for the authorization server: PKCE (RFC 7636, S256 only), the opaque codes it hands out, the user code
 * a person types on /activate, scope strings, and the duration grammar `relay invite create --expires 24h` uses.
 * Nothing here touches the database or the network, so every piece is unit-tested directly.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const b64url = (buf: Buffer): string => buf.toString("base64url");

/** `code_challenge = BASE64URL(SHA256(code_verifier))`. */
export const pkceChallenge = (verifier: string): string => b64url(createHash("sha256").update(verifier).digest());

/** A fresh RFC 7636 verifier: 32 random bytes, 43 base64url characters. */
export const pkceVerifier = (): string => b64url(randomBytes(32));

/** Constant-time check of a verifier against the challenge the authorization request carried. */
export function verifyPkce(verifier: string | undefined | null, challenge: string, method = "S256"): boolean {
  if (!verifier || method !== "S256") return false;
  if (verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(verifier)) return false;
  const a = Buffer.from(pkceChallenge(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Opaque, URL-safe secret with a readable prefix (`rac_` code, `rrt_` refresh, `rdc_` device, `rin_` invite). */
export const opaqueSecret = (prefix: string, bytes = 32): string => prefix + b64url(randomBytes(bytes));

export const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Letters and digits that survive being read aloud or typed from a phone: no 0/O, 1/I, A/E/U/Y (vowels avoid words). */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const USER_CODE_PREFIX = "RLAY";

/** `RLAY-4F7Q`: four characters from the alphabet above, about 614k combinations for a 15-minute window. */
export function newUserCode(length = 4): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  return `${USER_CODE_PREFIX}-${out}`;
}

/** What a person typed, normalised to the stored form: case, spaces, dashes and a missing prefix are forgiven. */
export function normalizeUserCode(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  let s = input.toUpperCase().replace(/[\s-]+/g, "");
  if (s.startsWith(USER_CODE_PREFIX)) s = s.slice(USER_CODE_PREFIX.length);
  if (!s || !/^[A-Z0-9]{4,8}$/.test(s)) return undefined;
  return `${USER_CODE_PREFIX}-${s}`;
}

/** OAuth `scope` is space-delimited; relay also accepts commas. Returns the unique names in request order. */
export function parseScopeParam(raw: string | string[] | null | undefined): string[] {
  const list = Array.isArray(raw) ? raw : (raw ?? "").split(/[\s,]+/);
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

export const scopeString = (scopes: readonly string[]): string => scopes.join(" ");

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

/** `30m`, `24h`, `7d`, `2w`, or a bare number of seconds. Undefined when unreadable or not positive. */
export function parseDuration(raw: string | number | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])?\s*$/i.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]) * UNITS[(m[2] ?? "s").toLowerCase()]!;
  return n > 0 ? Math.floor(n) : undefined;
}

/** Loopback redirect URIs may use any port (RFC 8252 §7.3); everything else must match exactly. */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  try {
    const a = new URL(registered);
    const b = new URL(presented);
    const loopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";
    return a.protocol === "http:" && b.protocol === "http:" && loopback(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

/** Redirect URIs a client may register: absolute, https or loopback http, or a private-use scheme (native apps). */
export function validRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) && u.protocol !== "javascript:" && u.protocol !== "data:";
}
