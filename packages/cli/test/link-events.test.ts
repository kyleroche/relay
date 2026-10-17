/**
 * The `events` stage of `relay link`: what it prints in local mode, in site mode for each answer the site can give
 * (App installed, not installed, no App configured), and that --no-events skips it. Site mode is RELAY_SITE +
 * RELAY_TOKEN with the global fetch replaced by a stub of the site's /api/v1, so nothing leaves the process;
 * --no-digest keeps the model steps out.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { GitHubStatus } from "@relay/core";

let registerLink: typeof import("../src/commands/link.ts").registerLink;
let tmp: string;
let repoDir: string;
const SITE = "https://relay.test";
const TOKEN = "rly_link_events";
const realFetch = globalThis.fetch;

/** The site's answer to GET /projects/demo/github for the next link run; undefined = 404. */
let status: GitHubStatus | undefined;
const seen: string[] = [];

function stubSite(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    seen.push(`${method} ${url.pathname}`);
    const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) return json(401, { title: "Unauthorized", detail: "bad token", instance: url.pathname });
    if (method === "PUT" && url.pathname === "/api/v1/projects/demo") return json(200, { project: { slug: "demo" }, created: false });
    if (method === "PUT" && url.pathname === "/api/v1/projects/demo/digests") return json(200, { files: 3 });
    if (method === "PUT" && url.pathname === "/api/v1/projects/demo/summary") return json(200, { slug: "demo", tokens: 1 });
    if (method === "GET" && url.pathname === "/api/v1/projects/demo/github") return status ? json(200, status) : json(404, { title: "Not Found", detail: "No project with slug 'demo'.", instance: url.pathname });
    return json(404, { title: "Not Found", detail: `unhandled ${method} ${url.pathname}`, instance: url.pathname });
  }) as typeof fetch;
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "relay-link-events-")));
  repoDir = join(tmp, "demo");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# demo\n");
  writeFileSync(join(repoDir, "src", "index.ts"), "export const answer = 42;\n");
  execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/demo.git"], { cwd: repoDir, stdio: "ignore" });
  process.env.RELAY_HOME = join(tmp, "harness");
  process.env.RELAY_FAKE_LANES = "1";
  ({ registerLink } = await import("../src/commands/link.ts"));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RELAY_SITE;
  delete process.env.RELAY_TOKEN;
  seen.length = 0;
});
afterAll(() => {
  delete process.env.RELAY_FAKE_LANES;
  rmSync(tmp, { recursive: true, force: true });
});

/** Run link and return the `[relay] ` lines it printed. */
async function link(...extra: string[]): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const program = new Command().exitOverride();
    registerLink(program);
    await program.parseAsync(["link", "--cwd", repoDir, "--no-labels", "--no-workflows", "--no-digest", ...extra], { from: "user" });
  } finally {
    console.error = orig;
  }
  return lines.map((l) => l.replace(/^\[relay\] /, ""));
}

const siteMode = (): void => {
  process.env.RELAY_SITE = SITE;
  process.env.RELAY_TOKEN = TOKEN;
  stubSite();
};

describe("relay link: the events stage", () => {
  it("in local mode says GitHub events are not ingested and points at relay setup --site", async () => {
    const lines = await link();
    expect(lines).toContain("info  events   local mode: GitHub events are not ingested; join a site with relay setup --site");
    expect(lines.at(-1)).toMatch(/^cost: /);
  });

  it("--no-events prints no events line", async () => {
    const lines = await link("--no-events");
    expect(lines.filter((l) => /\bevents\b/.test(l))).toEqual([]);
  });

  it("site mode, App installed: ok with the installation id, nothing left to do", async () => {
    siteMode();
    status = { repo: "acme/demo", app: { configured: true, slug: "relay-acme", installed: true, installation_id: 7, install_url: "https://github.com/apps/relay-acme/installations/new" }, webhook: { org_or_repo_hook_seen: true, last_delivery_at: "2026-10-16T10:00:00.000Z" } };
    const lines = await link();
    expect(lines).toContain("ok    events   GitHub App installed on acme/demo (installation 7)");
    expect(lines.at(-1)).toMatch(/^cost: /);
    // the check runs after the upload so a first link finds its project on the site
    expect(seen.indexOf("GET /api/v1/projects/demo/github")).toBeGreaterThan(seen.indexOf("PUT /api/v1/projects/demo/digests"));
  });

  it("site mode, App not installed: warn with the install link, and the final line names it as the one thing left", async () => {
    siteMode();
    status = { repo: "acme/demo", app: { configured: true, slug: "relay-acme", installed: false, installation_id: null, install_url: "https://github.com/apps/relay-acme/installations/new" }, webhook: { org_or_repo_hook_seen: false, last_delivery_at: null } };
    const lines = await link();
    expect(lines).toContain(`warn  events   GitHub App not installed on acme/demo: install it once at https://github.com/apps/relay-acme/installations/new (covers every repo you pick); until then issues, labels, PRs and previews from this repo do not reach ${SITE}`);
    expect(lines.at(-1)).toBe(`left: install the GitHub App on acme/demo at https://github.com/apps/relay-acme/installations/new; until then GitHub events from this repo do not reach ${SITE}`);
  });

  it("site mode, no App configured: warn pointing the operator at /setup/github", async () => {
    siteMode();
    status = { repo: "acme/demo", app: { configured: false, slug: null, installed: false, installation_id: null, install_url: `${SITE}/setup/github` }, webhook: { org_or_repo_hook_seen: false, last_delivery_at: null } };
    const lines = await link();
    expect(lines).toContain(`warn  events   ${SITE} has no GitHub App configured; the operator sets it up at ${SITE}/setup/github`);
    expect(lines.at(-1)).toBe(`left: ask the operator to configure the GitHub App at ${SITE}/setup/github; until then GitHub events from this repo do not reach ${SITE}`);
  });

  it("never fails the link when the site cannot answer", async () => {
    siteMode();
    status = undefined; // 404
    const lines = await link();
    expect(lines).toContain(`warn  events   ${SITE} does not know project demo yet; re-run relay link`);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
