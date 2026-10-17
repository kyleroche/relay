/**
 * Bearer tokens for /api/v1 writes and the MCP server. Three sources, checked in order:
 *
 *   1. RELAY_MEMORY_TOKEN           one shared secret that grants every scope (the HOSTING.md name)
 *   2. RELAY_API_TOKENS             static tokens with scopes: "tok1:feed:read,assets:write;tok2:memory:read".
 *                                   A bare entry without ':' grants every scope. Entries separated by ';' (or ','
 *                                   when no entry carries scopes). Minted by hand; useful without a database.
 *   3. the `tokens` table           when the app runs in db mode: `relay token create` rows, matched by SHA-256.
 *
 * Tokens are minted by `relay token create`, the /access page, and the authorization server (/oauth/*, whose access
 * tokens are rows in the same table named `oauth:<client>` with an expiry). The web app only checks them here.
 */
import { timingSafeEqual } from "node:crypto";
import { isTokenScope, TOKEN_SCOPES, type TokenScope } from "@relay/core";
import { dataMode } from "@/lib/data";

export type Scope = TokenScope;
export const SCOPES: Scope[] = [...TOKEN_SCOPES];

export interface Grant {
  scopes: Scope[];
  /** Attribution for writes made with this token. */
  actor: string;
  /** `session` is the signed-in browser viewer (lib/api.ts `sessionGrant`), never a token. */
  source: "shared" | "env" | "db" | "session";
  /** The token's name (`oauth:<client>`, `ci-runner`), the login for a session; for relay_whoami and /api/v1/whoami. */
  name: string;
  /** When the credential stops working; null for operator-minted tokens and env secrets. */
  expiresAt: string | null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Parse RELAY_API_TOKENS. Exported for tests and for the docs example to stay honest. */
export function parseStaticTokens(raw: string | undefined): Array<{ token: string; scopes: Scope[] }> {
  if (!raw?.trim()) return [];
  const entries = raw.includes(":") ? raw.split(";") : raw.split(/[;,]/);
  const out: Array<{ token: string; scopes: Scope[] }> = [];
  for (const entry of entries) {
    const e = entry.trim();
    if (!e) continue;
    const i = e.indexOf(":");
    if (i < 0) {
      out.push({ token: e, scopes: [...SCOPES] });
      continue;
    }
    const token = e.slice(0, i).trim();
    const scopes = e
      .slice(i + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(isTokenScope);
    if (token) out.push({ token, scopes });
  }
  return out;
}

export async function resolveGrant(token: string | null | undefined): Promise<Grant | undefined> {
  if (!token) return undefined;
  const shared = process.env.RELAY_MEMORY_TOKEN;
  if (shared && same(token, shared)) return { scopes: [...SCOPES], actor: "token:shared", source: "shared", name: "shared", expiresAt: null };
  for (const t of parseStaticTokens(process.env.RELAY_API_TOKENS)) {
    if (same(token, t.token)) return { scopes: t.scopes, actor: "token:env", source: "env", name: "env", expiresAt: null };
  }
  if (dataMode() === "db") {
    const [{ getDb }, { repo }] = await Promise.all([import("@/lib/db"), import("@relay/core")]);
    const row = await repo.findToken(await getDb(), token);
    if (row) return { scopes: row.scopes, actor: `token:${row.name}`, source: "db", name: row.name, expiresAt: row.expires_at };
  }
  return undefined;
}

export function bearerOf(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim() ?? null;
}
