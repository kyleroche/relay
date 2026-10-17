/**
 * `relay work container login`: the vendor logins made inside the relay-work container from the Mac, one command
 * (docs/WORKERS.md, "Isolation"). The container has no browser, so the two OAuth-redirect flows (`fx login codex`,
 * `fx login grok`) are driven from outside: fx prints its authorize URL, relay opens it in the Mac's browser and
 * catches the redirect on the Mac (the host listener), then hands the code to the login server inside. Claude Code
 * (paste a code) and gh (device code) are plain terminal passthroughs.
 *
 * This module is the pure part: the provider list, the URL and callback parsing, the words fx is run with and the
 * page the browser ends on. The process handling is in the CLI (packages/cli/src/commands/work.ts).
 */

/** The logins the container worker needs, in the order `login all` makes them: gh before the optional fx lanes. */
export const LOGIN_PROVIDERS = ["claude", "gh", "codex", "grok"] as const;
export type LoginProvider = (typeof LOGIN_PROVIDERS)[number];
/** The two the browser redirects for: fx's authorize URL is parsed and the redirect caught on the Mac. */
export const OAUTH_PROVIDERS: readonly LoginProvider[] = ["codex", "grok"];

export const isLoginProvider = (s: string): s is LoginProvider => (LOGIN_PROVIDERS as readonly string[]).includes(s);

/** How long `relay work container login` waits for one browser login before giving up with the by-hand steps. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * fx with its browser opening turned off (`FX_NO_OPEN_BROWSER=1`; `fx login <provider> --no-browser` does the same,
 * but the environment variable is accepted by every fx version and needs no flag placement): fx prints the authorize
 * URL and, for Grok, waits for the code on stdin. `env` carries the variable through `container exec`.
 */
export const fxLoginWords = (provider: "codex" | "grok"): string[] => ["env", "FX_NO_OPEN_BROWSER=1", "fx", "login", provider];

/** The authorize URL fx printed and the redirect it registered (`redirect_uri`): where the browser will land. */
export interface LoginRedirect {
  /** The full authorize URL, for the browser. */
  url: string;
  /** `redirect_uri` decoded: `http://127.0.0.1:42723/callback`, `http://localhost:1455/auth/callback`. */
  redirectUri: string;
  host: string;
  port: number;
  /** The path the redirect lands on (`/callback`, `/auth/callback`). */
  path: string;
  /** The `state` fx put in the URL, when any; the callback's must match it. */
  state?: string;
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * The first URL in `text` that carries a `redirect_uri` pointing at a loopback address: fx's authorize URL. Text is
 * what fx has printed so far, so a URL cut by a chunk boundary is simply not matched yet; call again with more.
 * Trailing punctuation a sentence may leave on the URL is dropped.
 */
export function parseLoginUrl(text: string): LoginRedirect | undefined {
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0]!.replace(/[.,;:!?]+$/, "");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const redirect = u.searchParams.get("redirect_uri");
    if (!redirect) continue;
    let r: URL;
    try {
      r = new URL(redirect);
    } catch {
      continue;
    }
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(r.hostname)) continue;
    const port = r.port ? Number(r.port) : r.protocol === "https:" ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0) continue;
    const state = u.searchParams.get("state");
    return { url: raw, redirectUri: redirect, host: r.hostname, port, path: r.pathname || "/", ...(state ? { state } : {}) };
  }
  return undefined;
}

/** What the browser's redirect carried: the code to hand to fx, the state, or the provider's error. */
export interface LoginCallback {
  code?: string;
  state?: string;
  error?: string;
  /** `error_description` when the provider sent one. */
  errorDescription?: string;
}

/** The query of the request the browser made to the host listener (`/callback?state=…&code=…`). */
export function parseLoginCallback(requestUrl: string): LoginCallback {
  const u = new URL(requestUrl, "http://127.0.0.1");
  const q = u.searchParams;
  const out: LoginCallback = {};
  const code = q.get("code");
  const state = q.get("state");
  const error = q.get("error");
  const desc = q.get("error_description");
  if (code) out.code = code;
  if (state) out.state = state;
  if (error) out.error = error;
  if (desc) out.errorDescription = desc;
  return out;
}

/**
 * The redirect replayed to the login server inside the container, on its loopback: the same path and query the
 * browser sent, at `http://localhost:<port>`. Used for Codex, whose listener completes the flow itself.
 */
export function replayUrl(redirect: LoginRedirect, requestUrl: string): string {
  const u = new URL(requestUrl, "http://127.0.0.1");
  return `http://${redirect.host}:${redirect.port}${redirect.path}${u.search}`;
}

/** The page the browser ends on once the host listener has the code. */
export function loginDonePage(provider: string, ok: boolean, detail?: string): string {
  const title = ok ? `${provider}: signed in` : `${provider}: sign-in failed`;
  const body = ok ? "relay has the code and is finishing the login inside the container. You can close this tab." : `${detail ?? "the provider returned an error"}. Go back to the terminal.`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;color:#222}h1{font-size:1.25rem}</style></head><body><h1>${esc(title)}</h1><p>${esc(body)}</p></body></html>\n`;
}

/** The steps a person does by hand when the one command cannot finish a login; printed on timeouts and refusals. */
export function manualLoginSteps(provider: LoginProvider): string[] {
  switch (provider) {
    case "claude":
      return ["relay work container shell", "claude   # then /login; open the URL it prints on this Mac, paste the code back, then /exit"];
    case "gh":
      return ["relay work container shell", "gh auth login --git-protocol https --web && gh auth setup-git   # the device code prints here; enter it at github.com/login/device"];
    case "codex":
      return ["relay work container shell", "fx login codex   # open the printed URL on this Mac; the redirect to localhost:1455 reaches the container through its published port"];
    case "grok":
      return [
        "relay work container shell",
        "FX_NO_OPEN_BROWSER=1 fx login grok   # open the printed URL on this Mac; when the browser ends on an unreachable 127.0.0.1:<port>/callback?state=…&code=… page, paste only the code value into fx's prompt (the whole address fails; each code is single-use)",
      ];
  }
}
