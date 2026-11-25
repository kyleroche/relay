/**
 * Whether relay is connected, read from the environment each time it is asked: the connection, the instructions and
 * the usage hook must all agree, and an operator who sets the variables should not need a different build.
 */

export type RelayStatus =
  | { connected: true; site: string; token: string }
  /** `missing` names the unset variables; `invalid` says what is wrong with one that is set. */
  | { connected: false; missing: string[]; invalid?: string };

/**
 * The scopes the lead's token needs, in the order the operator is told them: one for each relay tool on its list
 * (`relay-tools.ts`) and no other. Not `tasks:decide` (approve, close), not `tokens:write` (release, access), not
 * `memory:write` (decisions and preferences): relay's server refuses those tools to a token without the scope,
 * whatever the lead asks for.
 */
export const LEAD_SCOPES = ["tasks:read", "tasks:write", "memory:read", "feed:read", "events:write"] as const;

/** The site's origin without a trailing slash, or undefined when it is not somewhere the token may be sent. */
function siteOrigin(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  // the token is the lead's whole authority on relay: TLS, or this machine (a local site, the evals' fake)
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return undefined;
  if (u.username || u.password || u.search || u.hash) return undefined;
  return u.origin + u.pathname.replace(/\/+$/, "");
}

export function relayStatus(env: NodeJS.ProcessEnv = process.env): RelayStatus {
  const site = env.RELAY_SITE?.trim();
  const token = env.RELAY_TOKEN?.trim();
  const missing = [...(site ? [] : ["RELAY_SITE"]), ...(token ? [] : ["RELAY_TOKEN"])];
  if (!site || !token) return { connected: false, missing };
  const origin = siteOrigin(site);
  if (!origin) return { connected: false, missing: [], invalid: "RELAY_SITE must be the site's https URL, such as https://relay.example.com" };
  return { connected: true, site: origin, token };
}
