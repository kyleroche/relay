/**
 * Bearer tokens for the HTTP surfaces (web API, MCP over HTTP). A token is `rly_` + 32 random bytes in base64url;
 * only its SHA-256 is stored, so a database leak does not leak credentials. `createToken` returns the plaintext once.
 */
import { randomBytes } from "node:crypto";
import { type Db, iso } from "./client.ts";
import { sha256, ulid } from "../util.ts";

export const TOKEN_SCOPES = [
  "feed:read",
  "memory:read",
  "memory:write",
  "assets:read",
  "assets:write",
  "assets:review",
  "tasks:read",
  "tasks:write",
  "events:write",
  "projects:write",
  "webhooks:write",
  "tokens:write",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const isTokenScope = (s: string): s is TokenScope => (TOKEN_SCOPES as readonly string[]).includes(s);

/** One line per scope, for the token page, the OpenAPI description and `relay token create --help`. */
export const TOKEN_SCOPE_DESCRIPTIONS: Record<TokenScope, string> = {
  "feed:read": "Read the feed and projects.",
  "memory:read": "Read decisions, preferences, briefs and guidance.",
  "memory:write": "Record decisions and preferences.",
  "assets:read": "List and view assets (signed URLs).",
  "assets:write": "Upload, finalize and publish assets.",
  "assets:review": "Approve or reject assets.",
  "tasks:read": "Read tasks and their derived state.",
  "tasks:write": "Open tasks (GitHub issues with a lane label).",
  "events:write": "Log external.* events; the actor is always bot:<token name>.",
  "projects:write": "Register projects and upload digests and summaries (relay link in site mode).",
  "webhooks:write": "Add, list, remove and test outbound webhooks.",
  "tokens:write": "Mint, list and revoke tokens (relay token in site mode).",
};

export interface TokenRow {
  id: string;
  name: string;
  scopes: TokenScope[];
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  /** Null for operator-minted tokens; set on OAuth access tokens (24 h) so `findToken` stops honouring them. */
  expires_at: string | null;
  /** The OAuth client the token was issued to, when it came from the authorization server. */
  client_id: string | null;
}

const cols = "id, name, scopes, created_by, created_at, last_used_at, revoked_at, expires_at, client_id";
const toToken = (r: Record<string, unknown>): TokenRow => ({
  id: r.id as string,
  name: r.name as string,
  scopes: (Array.isArray(r.scopes) ? (r.scopes as string[]) : []).filter(isTokenScope),
  created_by: r.created_by as string,
  created_at: iso(r.created_at) ?? "",
  last_used_at: iso(r.last_used_at),
  revoked_at: iso(r.revoked_at),
  expires_at: iso(r.expires_at),
  client_id: (r.client_id as string | null) ?? null,
});

export const TOKEN_PREFIX = "rly_";

/** Hash used for storage and lookup. Exported so tests and the web app can build fixtures. */
export const hashToken = (token: string): string => sha256(token);

/** Mint a token. Unknown scope names throw. The plaintext is in the result and nowhere else. */
export async function createToken(db: Db, input: { name: string; scopes: string[]; createdBy: string; expiresAt?: Date | string | null; clientId?: string | null }): Promise<{ token: string; row: TokenRow }> {
  const scopes = [...new Set(input.scopes.map((s) => s.trim()).filter(Boolean))];
  const bad = scopes.filter((s) => !isTokenScope(s));
  if (bad.length) throw new Error(`unknown scope(s): ${bad.join(", ")}; valid: ${TOKEN_SCOPES.join(", ")}`);
  if (!scopes.length) throw new Error("a token needs at least one scope");
  if (!input.name.trim()) throw new Error("a token needs a name");
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const r = await db.query(
    `INSERT INTO tokens (id, name, token_hash, scopes, created_by, expires_at, client_id) VALUES ($1, $2, $3, $4::text[], $5, $6, $7) RETURNING ${cols}`,
    [ulid(), input.name.trim(), hashToken(token), scopes, input.createdBy, input.expiresAt ? new Date(input.expiresAt) : null, input.clientId ?? null],
  );
  return { token, row: toToken(r[0]!) };
}

/** The live row for a presented token (not revoked, not expired), or undefined. Touches last_used_at (best effort). */
export async function findToken(db: Db, token: string): Promise<TokenRow | undefined> {
  if (!token) return undefined;
  const r = await db.query(`SELECT ${cols} FROM tokens WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [hashToken(token)]);
  if (!r[0]) return undefined;
  const row = toToken(r[0]);
  await db.query("UPDATE tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => {});
  return row;
}

export async function listTokens(db: Db, opts: { includeRevoked?: boolean } = {}): Promise<TokenRow[]> {
  const r = await db.query(`SELECT ${cols} FROM tokens ${opts.includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY created_at DESC`);
  return r.map(toToken);
}

/** One row by id, revoked or not (the OAuth server reads the name of the token a refresh replaces). */
export async function getTokenById(db: Db, id: string): Promise<TokenRow | undefined> {
  const r = await db.query(`SELECT ${cols} FROM tokens WHERE id = $1`, [id]);
  return r[0] ? toToken(r[0]) : undefined;
}

/** Revoke by id, with no name lookup (the OAuth server knows the row it minted). */
export async function revokeTokenById(db: Db, id: string): Promise<TokenRow | undefined> {
  const r = await db.query(`UPDATE tokens SET revoked_at = now() WHERE revoked_at IS NULL AND id = $1 RETURNING ${cols}`, [id]);
  return r[0] ? toToken(r[0]) : undefined;
}

/** Revoke by the plaintext's hash: what `POST /oauth/revoke` does with an access token. */
export async function revokeTokenByHash(db: Db, tokenHash: string): Promise<TokenRow | undefined> {
  const r = await db.query(`UPDATE tokens SET revoked_at = now() WHERE revoked_at IS NULL AND token_hash = $1 RETURNING ${cols}`, [tokenHash]);
  return r[0] ? toToken(r[0]) : undefined;
}

/** Revoke by id (or by name when no id matches). Returns the row, or undefined when nothing matched. */
export async function revokeToken(db: Db, idOrName: string): Promise<TokenRow | undefined> {
  const r = await db.query(`UPDATE tokens SET revoked_at = now() WHERE revoked_at IS NULL AND (id = $1 OR name = $1) RETURNING ${cols}`, [idOrName]);
  return r[0] ? toToken(r[0]) : undefined;
}
