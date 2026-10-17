/**
 * Typed queries for the authorization server's tables (migration 006): clients, authorization codes, device codes,
 * refresh tokens and invites. Every secret is looked up by its SHA-256; the plaintext never reaches a row. The grant
 * logic (what a valid exchange is) lives in oauth/server.ts; this file only reads and writes.
 */
import { type Db, iso, num } from "./client.ts";
import { sha256hex } from "../oauth/codes.ts";
import { ulid } from "../util.ts";

// ---------- clients ----------

export interface OAuthClientRow {
  client_id: string;
  /** Present only for confidential clients; the plaintext is returned once at registration. */
  has_secret: boolean;
  name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  scopes: string[];
  software_id: string | null;
  client_uri: string | null;
  created_by: string;
  created_at: string;
}

const ccols = "client_id, client_secret_hash, name, redirect_uris, grant_types, token_endpoint_auth_method, scopes, software_id, client_uri, created_by, created_at";
const toClient = (r: Record<string, unknown>): OAuthClientRow => ({
  client_id: r.client_id as string,
  has_secret: !!r.client_secret_hash,
  name: r.name as string,
  redirect_uris: Array.isArray(r.redirect_uris) ? (r.redirect_uris as string[]) : [],
  grant_types: Array.isArray(r.grant_types) ? (r.grant_types as string[]) : [],
  token_endpoint_auth_method: (r.token_endpoint_auth_method as string) ?? "none",
  scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
  software_id: (r.software_id as string | null) ?? null,
  client_uri: (r.client_uri as string | null) ?? null,
  created_by: (r.created_by as string) ?? "",
  created_at: iso(r.created_at) ?? "",
});

export async function insertClient(
  db: Db,
  c: { client_id: string; client_secret_hash?: string | null; name: string; redirect_uris: string[]; grant_types: string[]; token_endpoint_auth_method: string; scopes: string[]; software_id?: string | null; client_uri?: string | null; created_by: string },
): Promise<OAuthClientRow> {
  const r = await db.query(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, name, redirect_uris, grant_types, token_endpoint_auth_method, scopes, software_id, client_uri, created_by)
     VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7::text[], $8, $9, $10) RETURNING ${ccols}`,
    [c.client_id, c.client_secret_hash ?? null, c.name, c.redirect_uris, c.grant_types, c.token_endpoint_auth_method, c.scopes, c.software_id ?? null, c.client_uri ?? null, c.created_by],
  );
  return toClient(r[0]!);
}

export async function getClient(db: Db, clientId: string): Promise<OAuthClientRow | undefined> {
  const r = await db.query(`SELECT ${ccols} FROM oauth_clients WHERE client_id = $1`, [clientId]);
  return r[0] ? toClient(r[0]) : undefined;
}

/** Constant-time check of a confidential client's secret; false for public clients and unknown ids. */
export async function clientSecretMatches(db: Db, clientId: string, secret: string | undefined | null): Promise<boolean> {
  if (!secret) return false;
  const r = await db.query<{ client_secret_hash: string | null }>("SELECT client_secret_hash FROM oauth_clients WHERE client_id = $1", [clientId]);
  const hash = r[0]?.client_secret_hash;
  return !!hash && hash === sha256hex(secret);
}

// ---------- authorization codes ----------

export interface OAuthCodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  scopes: string[];
  code_challenge: string;
  code_challenge_method: string;
  resource: string | null;
  actor: string;
  expires_at: string;
  used_at: string | null;
}

const kcols = "code_hash, client_id, redirect_uri, scopes, code_challenge, code_challenge_method, resource, actor, expires_at, used_at";
const toCode = (r: Record<string, unknown>): OAuthCodeRow => ({
  code_hash: r.code_hash as string,
  client_id: r.client_id as string,
  redirect_uri: r.redirect_uri as string,
  scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
  code_challenge: r.code_challenge as string,
  code_challenge_method: (r.code_challenge_method as string) ?? "S256",
  resource: (r.resource as string | null) ?? null,
  actor: r.actor as string,
  expires_at: iso(r.expires_at) ?? "",
  used_at: iso(r.used_at),
});

export async function insertCode(db: Db, c: { code: string; client_id: string; redirect_uri: string; scopes: string[]; code_challenge: string; code_challenge_method: string; resource?: string | null; actor: string; expires_at: Date }): Promise<void> {
  await db.query(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, scopes, code_challenge, code_challenge_method, resource, actor, expires_at) VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9)`,
    [sha256hex(c.code), c.client_id, c.redirect_uri, c.scopes, c.code_challenge, c.code_challenge_method, c.resource ?? null, c.actor, c.expires_at],
  );
}

/** Mark a code used and return it, in one statement so a replayed code loses the race. Undefined when already used or unknown. */
export async function consumeCode(db: Db, code: string): Promise<OAuthCodeRow | undefined> {
  const r = await db.query(`UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL RETURNING ${kcols}`, [sha256hex(code)]);
  return r[0] ? toCode(r[0]) : undefined;
}

// ---------- device codes ----------

export type DeviceStatus = "pending" | "approved" | "denied" | "redeemed";

export interface DeviceCodeRow {
  device_code_hash: string;
  user_code: string;
  client_id: string;
  client_name: string;
  scopes: string[];
  status: DeviceStatus;
  actor: string | null;
  decided_at: string | null;
  token_id: string | null;
  interval_seconds: number;
  last_polled_at: string | null;
  expires_at: string;
  created_at: string;
}

const dcols = "d.device_code_hash, d.user_code, d.client_id, c.name AS client_name, d.scopes, d.status, d.actor, d.decided_at, d.token_id, d.interval_seconds, d.last_polled_at, d.expires_at, d.created_at";
const dfrom = "FROM oauth_device_codes d JOIN oauth_clients c ON c.client_id = d.client_id";
const toDevice = (r: Record<string, unknown>): DeviceCodeRow => ({
  device_code_hash: r.device_code_hash as string,
  user_code: r.user_code as string,
  client_id: r.client_id as string,
  client_name: (r.client_name as string) ?? "",
  scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
  status: r.status as DeviceStatus,
  actor: (r.actor as string | null) ?? null,
  decided_at: iso(r.decided_at),
  token_id: (r.token_id as string | null) ?? null,
  interval_seconds: num(r.interval_seconds) || 5,
  last_polled_at: iso(r.last_polled_at),
  expires_at: iso(r.expires_at) ?? "",
  created_at: iso(r.created_at) ?? "",
});

export async function insertDeviceCode(db: Db, d: { device_code: string; user_code: string; client_id: string; scopes: string[]; interval_seconds: number; expires_at: Date }): Promise<DeviceCodeRow> {
  await db.query(`INSERT INTO oauth_device_codes (device_code_hash, user_code, client_id, scopes, interval_seconds, expires_at) VALUES ($1, $2, $3, $4::text[], $5, $6)`, [
    sha256hex(d.device_code),
    d.user_code,
    d.client_id,
    d.scopes,
    d.interval_seconds,
    d.expires_at,
  ]);
  return (await getDeviceByCode(db, d.device_code))!;
}

export async function getDeviceByCode(db: Db, deviceCode: string): Promise<DeviceCodeRow | undefined> {
  const r = await db.query(`SELECT ${dcols} ${dfrom} WHERE d.device_code_hash = $1`, [sha256hex(deviceCode)]);
  return r[0] ? toDevice(r[0]) : undefined;
}

export async function getDeviceByUserCode(db: Db, userCode: string): Promise<DeviceCodeRow | undefined> {
  const r = await db.query(`SELECT ${dcols} ${dfrom} WHERE d.user_code = $1`, [userCode]);
  return r[0] ? toDevice(r[0]) : undefined;
}

export async function userCodeTaken(db: Db, userCode: string): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM oauth_device_codes WHERE user_code = $1", [userCode]);
  return r.length > 0;
}

/** Pending requests a person (or Woodhouse) may still act on, newest first. `now` is the server's clock. */
export async function listPendingDevices(db: Db, now: Date = new Date()): Promise<DeviceCodeRow[]> {
  const r = await db.query(`SELECT ${dcols} ${dfrom} WHERE d.status = 'pending' AND d.expires_at > $1 ORDER BY d.created_at DESC`, [now]);
  return r.map(toDevice);
}

/** Record a poll; the caller compares the row's previous `last_polled_at` with the interval to answer slow_down. */
export async function touchDevicePoll(db: Db, deviceCodeHash: string, now: Date): Promise<void> {
  await db.query("UPDATE oauth_device_codes SET last_polled_at = $2 WHERE device_code_hash = $1", [deviceCodeHash, now]);
}

/** Approve or deny a pending request; undefined when it was not pending any more. */
export async function decideDevice(db: Db, userCode: string, decision: { status: "approved" | "denied"; actor: string; now?: Date }): Promise<DeviceCodeRow | undefined> {
  const now = decision.now ?? new Date();
  const r = await db.query<{ device_code_hash: string }>(`UPDATE oauth_device_codes SET status = $2, actor = $3, decided_at = $4 WHERE user_code = $1 AND status = 'pending' AND expires_at > $4 RETURNING device_code_hash`, [userCode, decision.status, decision.actor, now]);
  if (!r[0]) return undefined;
  return getDeviceByUserCode(db, userCode);
}

/** Mark approved → redeemed and record the token, once; undefined if someone else got there first. */
export async function redeemDevice(db: Db, deviceCodeHash: string, tokenId: string): Promise<boolean> {
  const r = await db.query(`UPDATE oauth_device_codes SET status = 'redeemed', token_id = $2 WHERE device_code_hash = $1 AND status = 'approved' RETURNING device_code_hash`, [deviceCodeHash, tokenId]);
  return r.length > 0;
}

// ---------- refresh tokens ----------

export interface RefreshTokenRow {
  token_hash: string;
  client_id: string;
  access_token_id: string | null;
  scopes: string[];
  actor: string;
  expires_at: string;
  rotated_from: string | null;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const rcols = "token_hash, client_id, access_token_id, scopes, actor, expires_at, rotated_from, used_at, revoked_at, created_at";
const toRefresh = (r: Record<string, unknown>): RefreshTokenRow => ({
  token_hash: r.token_hash as string,
  client_id: r.client_id as string,
  access_token_id: (r.access_token_id as string | null) ?? null,
  scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
  actor: r.actor as string,
  expires_at: iso(r.expires_at) ?? "",
  rotated_from: (r.rotated_from as string | null) ?? null,
  used_at: iso(r.used_at),
  revoked_at: iso(r.revoked_at),
  created_at: iso(r.created_at) ?? "",
});

export async function insertRefreshToken(db: Db, t: { token: string; client_id: string; access_token_id: string; scopes: string[]; actor: string; expires_at: Date; rotated_from?: string | null }): Promise<RefreshTokenRow> {
  const r = await db.query(
    `INSERT INTO oauth_refresh_tokens (token_hash, client_id, access_token_id, scopes, actor, expires_at, rotated_from) VALUES ($1, $2, $3, $4::text[], $5, $6, $7) RETURNING ${rcols}`,
    [sha256hex(t.token), t.client_id, t.access_token_id, t.scopes, t.actor, t.expires_at, t.rotated_from ?? null],
  );
  return toRefresh(r[0]!);
}

export async function getRefreshToken(db: Db, token: string): Promise<RefreshTokenRow | undefined> {
  const r = await db.query(`SELECT ${rcols} FROM oauth_refresh_tokens WHERE token_hash = $1`, [sha256hex(token)]);
  return r[0] ? toRefresh(r[0]) : undefined;
}

/** Rotation: mark used exactly once. False when it was already used (replay) or revoked. */
export async function useRefreshToken(db: Db, tokenHash: string): Promise<boolean> {
  const r = await db.query(`UPDATE oauth_refresh_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING token_hash`, [tokenHash]);
  return r.length > 0;
}

export async function revokeRefreshToken(db: Db, tokenHash: string): Promise<RefreshTokenRow | undefined> {
  const r = await db.query(`UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING ${rcols}`, [tokenHash]);
  return r[0] ? toRefresh(r[0]) : undefined;
}

/**
 * A reused refresh token means the chain leaked: revoke every descendant of the reused one (and their access tokens).
 * Returns the ids of the access tokens revoked so the caller can revoke those rows too.
 */
export async function revokeRefreshLineage(db: Db, tokenHash: string): Promise<string[]> {
  const r = await db.query<{ access_token_id: string | null }>(
    `WITH RECURSIVE chain AS (
       SELECT token_hash, access_token_id FROM oauth_refresh_tokens WHERE token_hash = $1
       UNION ALL
       SELECT t.token_hash, t.access_token_id FROM oauth_refresh_tokens t JOIN chain ON t.rotated_from = chain.token_hash
     )
     UPDATE oauth_refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE token_hash IN (SELECT token_hash FROM chain) RETURNING access_token_id`,
    [tokenHash],
  );
  return r.map((x) => x.access_token_id).filter((x): x is string => !!x);
}

// ---------- invites ----------

export interface InviteRow {
  id: string;
  name: string;
  scopes: string[];
  uses_left: number;
  max_uses: number;
  expires_at: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  last_redeemed_at: string | null;
}

const icols = "id, name, scopes, uses_left, max_uses, expires_at, created_by, created_at, revoked_at, last_redeemed_at";
const toInvite = (r: Record<string, unknown>): InviteRow => ({
  id: r.id as string,
  name: r.name as string,
  scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
  uses_left: num(r.uses_left),
  max_uses: num(r.max_uses),
  expires_at: iso(r.expires_at) ?? "",
  created_by: r.created_by as string,
  created_at: iso(r.created_at) ?? "",
  revoked_at: iso(r.revoked_at),
  last_redeemed_at: iso(r.last_redeemed_at),
});

export async function insertInvite(db: Db, i: { code: string; name: string; scopes: string[]; uses: number; expires_at: Date; created_by: string }): Promise<InviteRow> {
  const r = await db.query(`INSERT INTO invites (id, code_hash, name, scopes, uses_left, max_uses, expires_at, created_by) VALUES ($1, $2, $3, $4::text[], $5, $5, $6, $7) RETURNING ${icols}`, [
    ulid(),
    sha256hex(i.code),
    i.name,
    i.scopes,
    i.uses,
    i.expires_at,
    i.created_by,
  ]);
  return toInvite(r[0]!);
}

export async function getInviteByCode(db: Db, code: string): Promise<InviteRow | undefined> {
  const r = await db.query(`SELECT ${icols} FROM invites WHERE code_hash = $1`, [sha256hex(code)]);
  return r[0] ? toInvite(r[0]) : undefined;
}

/** Spend one use, atomically; undefined when the invite is gone, used up, expired or revoked. */
export async function consumeInvite(db: Db, code: string, now: Date = new Date()): Promise<InviteRow | undefined> {
  const r = await db.query(
    `UPDATE invites SET uses_left = uses_left - 1, last_redeemed_at = $2 WHERE code_hash = $1 AND uses_left > 0 AND revoked_at IS NULL AND expires_at > $2 RETURNING ${icols}`,
    [sha256hex(code), now],
  );
  return r[0] ? toInvite(r[0]) : undefined;
}

export async function listInvites(db: Db, opts: { includeSpent?: boolean; now?: Date } = {}): Promise<InviteRow[]> {
  const r = await db.query(`SELECT ${icols} FROM invites ${opts.includeSpent ? "" : "WHERE revoked_at IS NULL AND uses_left > 0 AND expires_at > $1"} ORDER BY created_at DESC`, opts.includeSpent ? [] : [opts.now ?? new Date()]);
  return r.map(toInvite);
}

export async function revokeInvite(db: Db, idOrName: string): Promise<InviteRow | undefined> {
  const r = await db.query(`UPDATE invites SET revoked_at = now() WHERE revoked_at IS NULL AND (id = $1 OR name = $1) RETURNING ${icols}`, [idOrName]);
  return r[0] ? toInvite(r[0]) : undefined;
}
