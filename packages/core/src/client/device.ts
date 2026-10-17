/**
 * How a machine gets a token from a hosted relay without anyone copying one (docs/INTEGRATIONS.md, "Connect in one
 * step"): the RFC 8628 device flow (`relay setup --site <url>` prints a code, the person approves it at /activate, the
 * CLI polls /oauth/token), the `urn:relay:invite` grant (`--invite <code>` redeems a one-time code with no approval),
 * and the refresh grant that keeps a 24-hour access token alive for 90 days. All three POST only to the configured site.
 */
import type { HttpFetch } from "./http.ts";
import { normalizeSite } from "./http.ts";

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_name?: string;
  expires_at?: string;
}

export interface DevicePrompt {
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export class OAuthClientError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly status: number,
  ) {
    super(description || code);
    this.name = "OAuthClientError";
  }
}

const defaultFetch: HttpFetch = (u, i) => fetch(u, i);

async function post(fetchImpl: HttpFetch, url: string, body: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== "") form.set(k, v);
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "relay-cli" }, body: form.toString() });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { error: "server_error", error_description: text.slice(0, 200) };
  }
  if (!res.ok) throw new OAuthClientError(String(json.error ?? `http_${res.status}`), String(json.error_description ?? json.detail ?? ""), res.status);
  return json;
}

const asToken = (j: Record<string, unknown>): OAuthTokenResponse => {
  if (typeof j.access_token !== "string") throw new OAuthClientError("server_error", "The token response carried no access_token.", 502);
  return {
    access_token: j.access_token,
    token_type: String(j.token_type ?? "Bearer"),
    expires_in: Number(j.expires_in ?? 0),
    ...(typeof j.refresh_token === "string" ? { refresh_token: j.refresh_token } : {}),
    ...(typeof j.scope === "string" ? { scope: j.scope } : {}),
    ...(typeof j.token_name === "string" ? { token_name: j.token_name } : {}),
    ...(typeof j.expires_at === "string" ? { expires_at: j.expires_at } : {}),
  };
};

export interface DeviceFlowOptions {
  site: string;
  /** Shown on the consent page and used as the token's name (`oauth:<clientName>`). */
  clientName: string;
  scopes: readonly string[];
  /** Called once with the code to show the person. */
  onPrompt: (p: DevicePrompt) => void;
  fetch?: HttpFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Give up after this long (default: the server's expires_in). */
  timeoutMs?: number;
}

/** Run the whole device flow: request a code, show it, poll until approved, denied or expired. */
export async function deviceFlow(opts: DeviceFlowOptions): Promise<OAuthTokenResponse> {
  const site = normalizeSite(opts.site);
  const f = opts.fetch ?? defaultFetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = (await post(f, `${site}/oauth/device`, { client_name: opts.clientName, scope: opts.scopes.join(" ") })) as unknown as DevicePrompt & { device_code: string; client_id: string };
  opts.onPrompt({ user_code: start.user_code, verification_uri: start.verification_uri, verification_uri_complete: start.verification_uri_complete, expires_in: start.expires_in, interval: start.interval });
  let interval = Math.max(1, Number(start.interval) || 5);
  const deadline = now() + (opts.timeoutMs ?? (Number(start.expires_in) || 900) * 1000);
  for (;;) {
    await sleep(interval * 1000);
    try {
      return asToken(await post(f, `${site}/oauth/token`, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code, client_id: start.client_id }));
    } catch (e) {
      if (!(e instanceof OAuthClientError)) throw e;
      if (e.code === "authorization_pending") {
        /* keep polling */
      } else if (e.code === "slow_down") interval += 5;
      else throw e;
    }
    if (now() > deadline) throw new OAuthClientError("expired_token", "Nobody approved the code in time. Run the command again for a new one.", 400);
  }
}

/** `relay setup --site <url> --invite <code>`: a token with no approval step. */
export async function redeemInvite(opts: { site: string; code: string; clientName: string; fetch?: HttpFetch }): Promise<OAuthTokenResponse> {
  return asToken(await post(opts.fetch ?? defaultFetch, `${normalizeSite(opts.site)}/oauth/token`, { grant_type: "urn:relay:invite", invite: opts.code, client_name: opts.clientName }));
}

/** Trade a refresh token for a new pair; the old refresh token is dead after this. */
export async function refreshAccessToken(opts: { site: string; refreshToken: string; fetch?: HttpFetch }): Promise<OAuthTokenResponse> {
  return asToken(await post(opts.fetch ?? defaultFetch, `${normalizeSite(opts.site)}/oauth/token`, { grant_type: "refresh_token", refresh_token: opts.refreshToken }));
}

/** What `relay setup` stores in credentials.json from a token response. */
export function credentialsFromToken(r: OAuthTokenResponse, now: number = Date.now()): { token: string; refreshToken: string | null; expiresAt: string | null } {
  const expiresAt = r.expires_at ?? (r.expires_in > 0 ? new Date(now + r.expires_in * 1000).toISOString() : null);
  return { token: r.access_token, refreshToken: r.refresh_token ?? null, expiresAt };
}

/** A token is "stale" when it expires within the margin (default two minutes); null expiry never is. */
export function tokenIsStale(expiresAt: string | null | undefined, now: number = Date.now(), marginMs = 120_000): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t - now < marginMs;
}
