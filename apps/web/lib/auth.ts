/**
 * Bearer tokens for /api/v1 writes and the MCP server. Three sources, checked in order:
 *
 *   1. RELAY_MEMORY_TOKEN           one shared secret that grants every scope (the HOSTING.md name)
 *   2. RELAY_API_TOKENS             static tokens with scopes: "tok1:feed:read,assets:write;tok2:memory:read".
 *                                   A bare entry without ':' grants every scope. Entries separated by ';' (or ','
 *                                   when no entry carries scopes). Minted by hand; useful without a database.
 *   3. the `tokens` table           when the app runs in db mode: `relay token create` rows, matched by SHA-256.
 *
 * Tokens are never minted here. The web app only checks them.
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
  source: "shared" | "env" | "db";
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
  if (shared && same(token, shared)) return { scopes: [...SCOPES], actor: "token:shared", source: "shared" };
  for (const t of parseStaticTokens(process.env.RELAY_API_TOKENS)) {
    if (same(token, t.token)) return { scopes: t.scopes, actor: "token:env", source: "env" };
  }
  if (dataMode() === "db") {
    const [{ getDb }, { repo }] = await Promise.all([import("@/lib/db"), import("@relay/core")]);
    const row = await repo.findToken(await getDb(), token);
    if (row) return { scopes: row.scopes, actor: `token:${row.name}`, source: "db" };
  }
  return undefined;
}

export function bearerOf(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim() ?? null;
}
