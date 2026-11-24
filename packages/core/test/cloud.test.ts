/**
 * A paid sandbox run, the pure parts (cloud/offer.ts, cloud/plan.ts): who is offered one and why not, what one is
 * expected to cost, the cap, the timeout, and exactly what a run creates.
 */
import { describe, expect, it } from "vitest";
import { capProblem, cloudLimits, cloudOffer, defaultCap, estimateUsd, subscriptionWorkers, type CloudLimits } from "../src/cloud/offer.ts";
import { CLOUD_GH_VARIABLE, CLOUD_MAX_TIMEOUT_MS, CLOUD_MIN_TIMEOUT_MS, CLOUD_PLACEHOLDER, cloudNames, CloudPlanError, cloudRunPlan, cloudTimeoutMs } from "../src/cloud/plan.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-11-24T12:00:00Z");
const limits: CloudLimits = { afterMinutes: 15, maxCapUsd: 10 };
const ago = (minutes: number): string => new Date(NOW - minutes * MIN).toISOString();
const task = (over: Partial<Parameters<typeof cloudOffer>[0]> = {}): Parameters<typeof cloudOffer>[0] => ({ state: "queued", lane: "claude", created_at: ago(40), ...over });
const worker = (state: "online" | "idle" | "offline", ...lanes: string[]) => ({ state, lanes });
const ask = { cloud: "ask" as const };

describe("cloudOffer", () => {
  it("offers a run for a queued task nobody can take, with how long it has waited", () => {
    expect(cloudOffer(task(), [], ask, NOW, limits)).toEqual({ offer: true, waitedMs: 40 * MIN });
    expect(cloudOffer(task(), [worker("offline", "claude"), worker("online", "codex", "nodes")], ask, NOW, limits)).toMatchObject({ offer: true });
  });

  it("offers nothing when a worker that is online or idle serves the lane", () => {
    expect(cloudOffer(task(), [worker("online", "claude")], ask, NOW, limits)).toMatchObject({ offer: false, why: "served" });
    expect(cloudOffer(task(), [worker("idle", "codex", "claude")], ask, NOW, limits)).toMatchObject({ offer: false, why: "served" });
  });

  it("counts any code lane as a taker for a task on `any`, and no other lane", () => {
    expect(cloudOffer(task({ lane: "any" }), [worker("online", "grok")], ask, NOW, limits)).toMatchObject({ offer: false, why: "served" });
    expect(cloudOffer(task({ lane: "any" }), [worker("online", "nodes", "embroidery")], ask, NOW, limits)).toMatchObject({ offer: true });
  });

  it("offers nothing when the profile says never, or could not be read", () => {
    expect(cloudOffer(task(), [], { cloud: "never" }, NOW, limits)).toMatchObject({ offer: false, why: "never" });
    expect(cloudOffer(task(), [], undefined, NOW, limits)).toMatchObject({ offer: false, why: "profile" });
  });

  it("offers nothing for a task younger than the threshold", () => {
    expect(cloudOffer(task({ created_at: ago(14) }), [], ask, NOW, limits)).toMatchObject({ offer: false, why: "young" });
    expect(cloudOffer(task({ created_at: ago(15) }), [], ask, NOW, limits)).toMatchObject({ offer: true });
    expect(cloudOffer(task({ created_at: "not a date" }), [], ask, NOW, limits)).toMatchObject({ offer: false, why: "young" });
  });

  it("offers nothing for a task that is not queued", () => {
    for (const state of ["waiting", "running", "review", "held", "blocked", "done", "failed", "closed"] as const) expect(cloudOffer(task({ state }), [], ask, NOW, limits)).toMatchObject({ offer: false, why: "state" });
  });

  it("offers nothing on a lane that has no paid adapter", () => {
    for (const lane of ["codex", "grok", "nodes", "embroidery", null]) expect(cloudOffer(task({ lane }), [], ask, NOW, limits)).toMatchObject({ offer: false, why: "lane" });
  });

  it("does not count the site's own cloud workers as machines that could take a task", () => {
    const fleet = [{ by: "kyle", state: "offline" as const, lanes: ["claude"] }, { by: "relay-site", state: "online" as const, lanes: ["claude"] }, { by: "vercel:project:p1:production", state: "online" as const, lanes: ["claude"] }];
    const own = subscriptionWorkers(fleet, { handle: "relay-site", principal: "vercel:project:p1:production" });
    expect(own.map((w) => w.by)).toEqual(["kyle"]);
    expect(cloudOffer(task(), own, ask, NOW, limits)).toMatchObject({ offer: true });
  });
});

describe("cloudLimits", () => {
  it("reads the deployment's limits, and falls back on anything that is no positive number", () => {
    expect(cloudLimits({})).toEqual({ afterMinutes: 15, maxCapUsd: 10 });
    expect(cloudLimits({ RELAY_CLOUD_AFTER_MINUTES: "5", RELAY_CLOUD_MAX_CAP_USD: "25" })).toEqual({ afterMinutes: 5, maxCapUsd: 25 });
    expect(cloudLimits({ RELAY_CLOUD_AFTER_MINUTES: "soon", RELAY_CLOUD_MAX_CAP_USD: "-3" })).toEqual({ afterMinutes: 15, maxCapUsd: 10 });
    expect(cloudLimits({ RELAY_CLOUD_AFTER_MINUTES: " ", RELAY_CLOUD_MAX_CAP_USD: "0" })).toEqual({ afterMinutes: 15, maxCapUsd: 10 });
    // a grant above $1000 is refused by the board's task functions, so no limit is higher
    expect(cloudLimits({ RELAY_CLOUD_MAX_CAP_USD: "5000" }).maxCapUsd).toBe(1000);
  });
});

describe("estimateUsd and defaultCap", () => {
  it("is the median of past runs, and nothing with fewer than three", () => {
    expect(estimateUsd([])).toBeNull();
    expect(estimateUsd([0.5, 0.9])).toBeNull();
    expect(estimateUsd([0.9, 0.5, 4])).toBe(0.9);
    expect(estimateUsd([1, 2, 3, 10])).toBe(2.5);
    expect(estimateUsd([0.333, 0.333, 0.333])).toBe(0.33);
  });

  it("leaves out rows that carry no cost", () => {
    expect(estimateUsd([0, 0, 0, 0.8, 1.2])).toBeNull();
    expect(estimateUsd([0, Number.NaN, 0.8, 1.2, 2])).toBe(1.2);
  });

  it("caps at twice the estimate, at least $1 and at most the deployment's limit", () => {
    expect(defaultCap(0.74, 10)).toBe(1.48);
    expect(defaultCap(0.2, 10)).toBe(1);
    expect(defaultCap(null, 10)).toBe(1);
    expect(defaultCap(8, 10)).toBe(10);
    // a deployment that allows less than a dollar is held to what it allows
    expect(defaultCap(3, 0.5)).toBe(0.5);
  });

  it("refuses a cap that is no amount or is over the limit", () => {
    expect(capProblem(2, 10)).toBeUndefined();
    expect(capProblem(10, 10)).toBeUndefined();
    expect(capProblem(10.01, 10)).toMatch(/at most \$10\.00/);
    expect(capProblem(0, 10)).toMatch(/above 0/);
    expect(capProblem(Number.NaN, 10)).toMatch(/above 0/);
  });
});

describe("cloudTimeoutMs", () => {
  it("grows with the cap between a quarter of an hour and an hour", () => {
    expect(cloudTimeoutMs(0.25)).toBe(CLOUD_MIN_TIMEOUT_MS);
    expect(cloudTimeoutMs(1)).toBe(20 * MIN);
    expect(cloudTimeoutMs(2.5)).toBe(35 * MIN);
    expect(cloudTimeoutMs(5)).toBe(CLOUD_MAX_TIMEOUT_MS);
  });

  it("is never more than 60 minutes, whatever the cap", () => {
    for (const cap of [10, 1000, Number.MAX_VALUE, Number.POSITIVE_INFINITY, Number.NaN, -4]) {
      expect(cloudTimeoutMs(cap)).toBeLessThanOrEqual(60 * MIN);
      expect(cloudTimeoutMs(cap)).toBeGreaterThanOrEqual(15 * MIN);
    }
  });
});

describe("cloudRunPlan", () => {
  const input = { task: { id: "790.771" }, cap: 2, relayVersion: "0.3.2", hosts: ["api.example.com", "*.example.org"] };

  it("says exactly what is created", () => {
    const plan = cloudRunPlan({ ...input, start: { grant: "790.800", n: 1 } });
    const names = cloudNames("790.771", { grant: "790.800", n: 1 });
    expect(plan).toMatchObject({ ...names, task: "790.771", capUsd: 2, image: "vercel/sandbox/universal", vcpus: 2, timeoutMs: 30 * MIN, gatewayUrl: "https://ai-gateway.vercel.sh/claude-code" });
    expect(plan.hosts).toEqual(["*.example.org", "ai-gateway.vercel.sh", "api.example.com", "api.github.com", "github.com", "registry.npmjs.org"]);
    expect(plan.env).toEqual(["BOARD_TOKEN", "BOARD_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "RELAY_BOARD_FROM", "RELAY_GATEWAY_TOKEN", "RELAY_GATEWAY_URL", "RELAY_HOME"]);
    expect(plan.commands.map((c) => c.step)).toEqual(["node", "git", "gh", "install", "github", "work"]);
    expect(plan.commands.find((c) => c.step === "install")).toMatchObject({ cmd: "npm", args: ["install", "-g", "--no-fund", "--no-audit", "@kyleroche/relay@0.3.2", "@anthropic-ai/claude-code"] });
    expect(plan.commands.at(-1)).toEqual({ step: "work", cmd: "relay", args: ["work", "--task", "790.771", "--billing", "gateway", "--cap", "2.00", "--no-sandbox", "--name", names.worker, "--max-minutes", "25"], detached: true });
  });

  it("names the worker for the task and the sandbox for the start", () => {
    const first = cloudNames("790.771", { grant: "790.800", n: 1 });
    expect(first.worker).toMatch(/^cloud-[0-9a-f]{8}$/);
    expect(first.profile).toBe(`relay-${first.worker}-claude`);
    expect(first.sandbox).toMatch(/^relay-cloud-[0-9a-f]{8}-[0-9a-f]{6}$/);
    expect(cloudNames("790.771", { grant: "790.800", n: 2 })).toMatchObject({ worker: first.worker, profile: first.profile });
    expect(cloudNames("790.771", { grant: "790.800", n: 2 }).sandbox).not.toBe(first.sandbox);
    expect(cloudNames("790.771", { grant: "790.900", n: 1 }).sandbox).not.toBe(first.sandbox);
    expect(cloudNames("790.772", { grant: "790.800", n: 1 }).worker).not.toBe(first.worker);
  });

  it("allows no host it was not given, and none twice", () => {
    expect(cloudRunPlan({ ...input, hosts: [] }).hosts).toEqual(["ai-gateway.vercel.sh", "api.github.com", "github.com", "registry.npmjs.org"]);
    expect(cloudRunPlan({ ...input, hosts: ["github.com", "api.example.com", "api.example.com"] }).hosts).toEqual(["ai-gateway.vercel.sh", "api.example.com", "api.github.com", "github.com", "registry.npmjs.org"]);
    expect(cloudRunPlan({ ...input, hosts: [], gatewayUrl: "https://gateway.example.net/claude/" })).toMatchObject({ gatewayUrl: "https://gateway.example.net/claude", hosts: ["api.github.com", "gateway.example.net", "github.com", "registry.npmjs.org"] });
  });

  it("holds the sandbox to the queues and its own worker message on the board", () => {
    expect(cloudRunPlan(input).board).toEqual({ "work/": ["read", "post", "react", "label"], "relay/workers": ["read", "post", "label"] });
  });

  it("never contains a credential value: variables are names, and the one login command reads a placeholder's variable", () => {
    const plan = cloudRunPlan(input);
    for (const name of [...plan.env, ...plan.commands.flatMap((c) => c.env ?? [])]) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    const login = plan.commands.find((c) => c.step === "github")!;
    expect(login.env).toEqual([CLOUD_GH_VARIABLE]);
    expect(login.args.join(" ")).toContain(`"$${CLOUD_GH_VARIABLE}"`);
    // nothing a caller passes in is a credential, so the only way one could appear is by being written here
    const text = JSON.stringify(plan);
    expect(text).not.toMatch(/Bearer|Basic |ghs_|ghp_|sk-|vck_|eyJ/);
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toContain(CLOUD_PLACEHOLDER);
    expect(Object.keys(plan).sort()).toEqual(["board", "capUsd", "commands", "env", "gatewayUrl", "hosts", "image", "profile", "sandbox", "task", "timeoutMs", "vcpus", "worker"]);
  });

  it("runs unsandboxed inside the microVM, on the gateway, for one task, under the cap", () => {
    const work = cloudRunPlan({ ...input, cap: 1.5 }).commands.at(-1)!;
    expect(work.args).toEqual(expect.arrayContaining(["--no-sandbox", "--billing", "gateway", "--task", "790.771"]));
    expect(work.args[work.args.indexOf("--cap") + 1]).toBe("1.50");
    expect(cloudRunPlan({ ...input, cap: 1.5 }).commands.filter((c) => c.args.includes("--no-sandbox"))).toHaveLength(1);
  });

  it("never outlives the credentials at the firewall", () => {
    const short = cloudRunPlan({ ...input, cap: 10, credentialLifeMs: 32 * MIN });
    expect(short.timeoutMs).toBe(30 * MIN);
    expect(short.commands.at(-1)!.args.slice(-2)).toEqual(["--max-minutes", "25"]);
    expect(cloudRunPlan({ ...input, cap: 1, credentialLifeMs: 90 * MIN }).timeoutMs).toBe(20 * MIN);
    expect(() => cloudRunPlan({ ...input, credentialLifeMs: 12 * MIN })).toThrow(/good for 12 more minutes/);
    expect(() => cloudRunPlan({ ...input, credentialLifeMs: -5 })).toThrow(CloudPlanError);
  });

  it("refuses a cap, a version, a host or a gateway that is not one", () => {
    expect(() => cloudRunPlan({ ...input, cap: 0 })).toThrow(/cap above \$0/);
    expect(() => cloudRunPlan({ ...input, cap: Number.NaN })).toThrow(CloudPlanError);
    for (const relayVersion of ["latest", "^0.3.2", "0.3", "0.3.2 && curl x", ""]) expect(() => cloudRunPlan({ ...input, relayVersion })).toThrow(/not an exact version/);
    expect(cloudRunPlan({ ...input, relayVersion: "0.4.0-beta.1" }).commands[3]!.args).toContain("@kyleroche/relay@0.4.0-beta.1");
    for (const host of ["*", "localhost", "https://api.example.com", "api.example.com/path", "a b.com", "10.0.0.1"]) expect(() => cloudRunPlan({ ...input, hosts: [host] })).toThrow(/not a host name/);
    for (const gatewayUrl of ["http://ai-gateway.vercel.sh", "not a url", "https://user:pw@gateway.example.net", "https://gateway.example.net/x?key=1"]) expect(() => cloudRunPlan({ ...input, gatewayUrl })).toThrow(/RELAY_GATEWAY_URL/);
  });
});
