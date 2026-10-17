/**
 * Operator settings the web app stores when the environment does not carry them (migration 006 `settings`). Today
 * that is the GitHub App the manifest flow creates: id, private key, webhook secret. Secret values are sealed with
 * AES-256-GCM under a key derived from RELAY_SESSION_SECRET, so a database dump alone cannot read them; rotating the
 * session secret makes them unreadable, which is the documented way to invalidate them (docs/HOSTING.md).
 *
 * The environment always wins: a value set in Vercel is used even when a sealed row exists (`apps/web/lib/github-app.ts`).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Db } from "./client.ts";

const VERSION = "v1";

function keyFor(secret: string): Buffer {
  if (!secret || secret.length < 16) throw new Error("RELAY_SESSION_SECRET must be set to at least 16 characters to seal settings.");
  return createHash("sha256").update(`relay-settings:${secret}`).digest();
}

/** `v1.<iv>.<ciphertext>.<tag>` in base64url. */
export function sealValue(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), ct.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

/** The plaintext, or undefined when the value was sealed under another secret or tampered with. */
export function openValue(sealed: string, secret: string): string | undefined {
  const [v, iv, ct, tag] = sealed.split(".");
  if (v !== VERSION || !iv || !ct || !tag) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

export interface SettingRow {
  key: string;
  value: string;
  sealed: boolean;
  updated_at: string;
}

/** Store a setting; `secret` seals it. */
export async function putSetting(db: Db, key: string, value: string, opts: { secret?: string } = {}): Promise<void> {
  const sealed = !!opts.secret;
  await db.query(
    `INSERT INTO settings (key, value, sealed, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, sealed = EXCLUDED.sealed, updated_at = now()`,
    [key, sealed ? sealValue(value, opts.secret!) : value, sealed],
  );
}

/** Read a setting, unsealing when needed; undefined when absent or unreadable with this secret. */
export async function getSetting(db: Db, key: string, opts: { secret?: string } = {}): Promise<string | undefined> {
  const r = await db.query<{ value: string; sealed: boolean }>("SELECT value, sealed FROM settings WHERE key = $1", [key]);
  const row = r[0];
  if (!row) return undefined;
  if (!row.sealed) return row.value;
  return opts.secret ? openValue(row.value, opts.secret) : undefined;
}

export async function deleteSettings(db: Db, prefix: string): Promise<number> {
  const r = await db.query("DELETE FROM settings WHERE key LIKE $1 RETURNING key", [`${prefix}%`]);
  return r.length;
}

/** Keys present (not values), for status pages. */
export async function listSettingKeys(db: Db, prefix: string): Promise<Array<{ key: string; sealed: boolean; updated_at: string }>> {
  const r = await db.query<{ key: string; sealed: boolean; updated_at: Date | string }>("SELECT key, sealed, updated_at FROM settings WHERE key LIKE $1 ORDER BY key", [`${prefix}%`]);
  return r.map((x) => ({ key: x.key, sealed: !!x.sealed, updated_at: x.updated_at instanceof Date ? x.updated_at.toISOString() : String(x.updated_at) }));
}
