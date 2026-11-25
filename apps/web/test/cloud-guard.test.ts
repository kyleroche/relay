/**
 * Whether a repository's default branch is safe to hand a paid run's token to (lib/cloud/guard.ts). The decision is
 * tested over answers shaped as GitHub's REST API gives them; no test calls GitHub.
 *
 * Where the shapes are from. Recorded on 2026-11-24 from the public API, unauthenticated, and cut down to the fields
 * read here:
 *
 *   GET /repos/vercel/next.js/rules/branches/canary   NEXT_RULES: several rulesets' rules for one branch
 *   GET /repos/vercel/next.js/branches/canary         `protection.enabled: false` on a branch only rulesets protect
 *   GET /repos/cli/cli/rules/branches/trunk           CLI_RULES: a ruleset that requires no pull request
 *   GET /repos/cli/cli/branches/trunk                 CLI_BRANCH: classic branch protection, `protection.enabled: true`
 *   GET /repos/cli/cli/rulesets/4898070               CLI_RULESET: what a caller without write access is told
 *
 * From GitHub's REST reference, since they are only returned to callers these tests are not (docs.github.com/en/rest):
 * `current_user_can_bypass` and `bypass_actors` of a ruleset (repos/rules), and the body of "Get branch protection"
 * (branches/branch-protection).
 */
import { describe, expect, it } from "vitest";
import { GitHubError } from "@relay/core";
import { branchGuard, bypassOf, guardFix, readGuard, type BranchRule, type GuardFacts } from "../lib/cloud/guard.ts";

const NEXT_RULES: BranchRule[] = JSON.parse(`[
  {"type":"required_signatures","ruleset_source_type":"Enterprise","ruleset_source":"vercel","ruleset_id":15412430},
  {"type":"deletion","ruleset_source_type":"Organization","ruleset_source":"vercel","ruleset_id":16241782},
  {"type":"non_fast_forward","ruleset_source_type":"Organization","ruleset_source":"vercel","ruleset_id":16241782},
  {"type":"pull_request","parameters":{"required_approving_review_count":1,"dismiss_stale_reviews_on_push":false,"required_reviewers":[],"require_code_owner_review":true,"require_last_push_approval":false,"required_review_thread_resolution":false,"require_extra_approval_for_unattributed_changes":true,"allowed_merge_methods":["merge","squash","rebase"]},"ruleset_source_type":"Organization","ruleset_source":"vercel","ruleset_id":20384721},
  {"type":"required_linear_history","ruleset_source_type":"Organization","ruleset_source":"vercel","ruleset_id":16241785},
  {"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,"required_reviewers":[],"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false,"require_extra_approval_for_unattributed_changes":true,"allowed_merge_methods":["squash"]},"ruleset_source_type":"Organization","ruleset_source":"vercel","ruleset_id":20384726},
  {"type":"deletion","ruleset_source_type":"Repository","ruleset_source":"vercel/next.js","ruleset_id":15507172},
  {"type":"non_fast_forward","ruleset_source_type":"Repository","ruleset_source":"vercel/next.js","ruleset_id":15507172}
]`);
const CLI_RULES: BranchRule[] = JSON.parse(`[{"type":"copilot_code_review","parameters":{"review_on_push":false,"review_draft_pull_requests":true},"ruleset_source_type":"Repository","ruleset_source":"cli/cli","ruleset_id":4898070}]`);
const CLI_BRANCH = JSON.parse(`{"name":"trunk","protected":true,"protection":{"enabled":true,"required_status_checks":{"enforcement_level":"non_admins","contexts":["build (macos-latest)"],"checks":[{"context":"build (macos-latest)","app_id":null}]}},"protection_url":"https://api.github.com/repos/cli/cli/branches/trunk/protection"}`) as Record<string, unknown>;
const NEXT_BRANCH = JSON.parse(`{"name":"canary","protected":true,"protection":{"enabled":false,"required_status_checks":{"enforcement_level":"off","contexts":[],"checks":[]}},"protection_url":"https://api.github.com/repos/vercel/next.js/branches/canary/protection"}`) as Record<string, unknown>;
const CLI_RULESET = JSON.parse(`{"id":4898070,"name":"Copilot Code Review","target":"branch","source_type":"Repository","source":"cli/cli","enforcement":"active","conditions":{"ref_name":{"exclude":[],"include":["~ALL"]}},"rules":[{"type":"copilot_code_review","parameters":{"review_on_push":false,"review_draft_pull_requests":true}}]}`) as Record<string, unknown>;

const APP = { id: 4242, slug: "relay-acme" };
/** A ruleset's pull request rule, as in NEXT_RULES, with the two parameters that decide. */
const pr = (approvals: number, lastPush: boolean, ruleset = 100): BranchRule => ({ type: "pull_request", parameters: { required_approving_review_count: approvals, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: lastPush, required_review_thread_resolution: false, allowed_merge_methods: ["squash"] }, ruleset_id: ruleset });
const facts = (over: Partial<GuardFacts> = {}): GuardFacts => ({ repo: "acme/atlas-site", branch: "main", rules: [], bypass: {}, classic: "off", app: APP, ...over });

describe("branchGuard", () => {
  it("passes a branch whose ruleset requires a pull request, an approval, and one of the most recent push", () => {
    expect(branchGuard(facts({ rules: [pr(1, true)], bypass: { 100: "no" } }))).toEqual({ ok: true, repo: "acme/atlas-site", branch: "main", by: "ruleset", bypassKnown: true });
    expect(branchGuard(facts({ rules: [pr(2, true)], bypass: { 100: "no" } }))).toMatchObject({ ok: true });
  });

  it("refuses a branch nothing protects: the lane could push straight to it", () => {
    const g = branchGuard(facts());
    expect(g).toMatchObject({ ok: false, why: "open", branch: "main" });
    expect(g.ok ? "" : g.message).toMatch(/^main of acme\/atlas-site takes direct pushes, .* it could push its work straight to main\./);
    // rules that keep a branch from being deleted or force-pushed do not keep a push or a merge off it
    expect(branchGuard(facts({ rules: [{ type: "deletion", ruleset_id: 1 }, { type: "non_fast_forward", ruleset_id: 1 }, { type: "required_linear_history", ruleset_id: 1 }] }))).toMatchObject({ ok: false, why: "open" });
    expect(branchGuard(facts({ rules: CLI_RULES }))).toMatchObject({ ok: false, why: "open" });
  });

  it("refuses a pull request rule with no approval: the lane could merge its own", () => {
    const g = branchGuard(facts({ rules: [pr(0, false)], bypass: { 100: "no" } }));
    expect(g).toMatchObject({ ok: false, why: "no-review" });
    expect(g.ok ? "" : g.message).toMatch(/requires a pull request but no approval.*merge its own pull request/);
    expect(branchGuard(facts({ rules: [pr(0, true)], bypass: { 100: "no" } }))).toMatchObject({ ok: false, why: "no-review" });
    // a parameter that is missing or is no number is no approval
    expect(branchGuard(facts({ rules: [{ type: "pull_request", ruleset_id: 100 }] }))).toMatchObject({ ok: false, why: "no-review" });
    expect(branchGuard(facts({ rules: [{ type: "pull_request", parameters: { required_approving_review_count: "1", require_last_push_approval: "true" }, ruleset_id: 100 }] }))).toMatchObject({ ok: false, why: "no-review" });
  });

  it("refuses an approval that need not be of the most recent push: the lane could push onto someone else's pull request and approve that", () => {
    const g = branchGuard(facts({ rules: [pr(1, false)], bypass: { 100: "no" } }));
    expect(g).toMatchObject({ ok: false, why: "last-push" });
    expect(g.ok ? "" : g.message).toMatch(/not of the most recent push.*approve it as relay's App and merge it/);
    // next.js's canary, as recorded: one approval and code owners, but not of the last push
    expect(branchGuard(facts({ repo: "vercel/next.js", branch: "canary", rules: NEXT_RULES }))).toMatchObject({ ok: false, why: "last-push" });
  });

  it("takes the strictest of the rules that apply, as GitHub does when rulesets stack", () => {
    // one ruleset asks for the approval, another for the last push's
    expect(branchGuard(facts({ rules: [pr(1, false, 1), pr(0, true, 2)], bypass: { 1: "no", 2: "no" } }))).toMatchObject({ ok: true, bypassKnown: true });
    expect(branchGuard(facts({ rules: [...NEXT_RULES, pr(1, true, 7)], bypass: { 7: "no" } }))).toMatchObject({ ok: true });
  });

  it("refuses a rule relay's App may bypass: a paid run's token is the App's", () => {
    const g = branchGuard(facts({ rules: [pr(1, true)], bypass: { 100: "yes" } }));
    expect(g).toMatchObject({ ok: false, why: "bypass" });
    expect(g.ok ? "" : g.message).toMatch(/relay's GitHub App may bypass that rule/);
    // what is left once the rulesets it may bypass are set aside is what counts
    expect(branchGuard(facts({ rules: [pr(1, true, 1), pr(1, false, 2)], bypass: { 1: "yes", 2: "no" } }))).toMatchObject({ ok: false, why: "bypass" });
    expect(branchGuard(facts({ rules: [pr(1, true, 1), pr(1, true, 2)], bypass: { 1: "yes", 2: "no" } }))).toMatchObject({ ok: true, bypassKnown: true });
  });

  it("passes a rule GitHub said nothing about bypassing, and says that it does not know", () => {
    expect(branchGuard(facts({ rules: [pr(1, true)] }))).toEqual({ ok: true, repo: "acme/atlas-site", branch: "main", by: "ruleset", bypassKnown: false });
    expect(branchGuard(facts({ rules: [pr(1, true)], bypass: { 100: "unknown" } }))).toMatchObject({ ok: true, bypassKnown: false });
    expect(branchGuard(facts({ rules: [pr(1, false, 1), pr(0, true, 2)], bypass: { 1: "no" } }))).toMatchObject({ ok: true, bypassKnown: false });
  });

  it("cannot believe classic branch protection it may not read, and says to use a ruleset", () => {
    const g = branchGuard(facts({ classic: "unreadable" }));
    expect(g).toMatchObject({ ok: false, why: "unreadable" });
    expect(g.ok ? "" : g.message).toMatch(/classic branch protection, which relay's GitHub App may not read/);
    expect(g.ok ? "" : g.message).toContain(guardFix("acme/atlas-site", "main"));
  });

  it("believes classic branch protection it can read, under the same three conditions", () => {
    const classic = (reviews: Record<string, unknown> | undefined) => facts({ classic: reviews ? { required_pull_request_reviews: reviews } : {} });
    expect(branchGuard(classic({ required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews: false, require_code_owner_reviews: false }))).toEqual({ ok: true, repo: "acme/atlas-site", branch: "main", by: "classic", bypassKnown: true });
    expect(branchGuard(classic({ required_approving_review_count: 1, require_last_push_approval: false }))).toMatchObject({ ok: false, why: "last-push" });
    expect(branchGuard(classic({ required_approving_review_count: 0, require_last_push_approval: true }))).toMatchObject({ ok: false, why: "no-review" });
    // protection with status checks only requires no pull request
    expect(branchGuard(classic(undefined))).toMatchObject({ ok: false, why: "open" });
    const allowances = (apps: unknown[]) => classic({ required_approving_review_count: 1, require_last_push_approval: true, bypass_pull_request_allowances: { users: [], teams: [], apps } });
    expect(branchGuard(allowances([{ id: 4242, slug: "relay-acme" }]))).toMatchObject({ ok: false, why: "bypass" });
    expect(branchGuard(allowances([{ slug: "relay-acme" }]))).toMatchObject({ ok: false, why: "bypass" });
    expect(branchGuard(allowances([{ id: 7, slug: "some-other-bot" }]))).toMatchObject({ ok: true, by: "classic" });
    // an app in the list that cannot be told from relay's is taken to be relay's
    expect(branchGuard(allowances([{}]))).toMatchObject({ ok: false, why: "bypass" });
  });

  it("says what to turn on, and what that means for relay's own Approve, in every refusal", () => {
    const fix = guardFix("acme/atlas-site", "main");
    expect(fix).toBe(
      `In acme/atlas-site, Settings, Rules, Rulesets, add a ruleset for main that requires a pull request before merging, with at least 1 approval and "Require approval of the most recent reviewable push", and leave relay's GitHub App off its bypass list. relay's Approve then merges a pull request only after someone approved it on GitHub.`,
    );
    for (const f of [facts(), facts({ rules: [pr(0, false)] }), facts({ rules: [pr(1, false)] }), facts({ rules: [pr(1, true)], bypass: { 100: "yes" } }), facts({ classic: "unreadable" })]) {
      const g = branchGuard(f);
      expect(g.ok).toBe(false);
      if (!g.ok) {
        expect(g.message.endsWith(fix)).toBe(true);
        // it fits in the line the pool leaves in a task's thread (core's cloudFailedText keeps 600 characters)
        expect(g.message.length).toBeLessThanOrEqual(600);
      }
    }
  });
});

describe("bypassOf", () => {
  it("reads what GitHub says about the caller", () => {
    expect(bypassOf({ ...CLI_RULESET, current_user_can_bypass: "never" }, APP)).toBe("no");
    for (const said of ["always", "pull_requests_only", "exempt"]) expect(bypassOf({ ...CLI_RULESET, current_user_can_bypass: said }, APP), said).toBe("yes");
  });

  it("looks for the App among the bypass actors when GitHub lists them", () => {
    const actors = (...list: unknown[]) => ({ ...CLI_RULESET, bypass_actors: list });
    expect(bypassOf(actors({ actor_id: 4242, actor_type: "Integration", bypass_mode: "always" }), APP)).toBe("yes");
    expect(bypassOf(actors({ actor_id: 4242, actor_type: "Integration", bypass_mode: "pull_request" }), APP)).toBe("yes");
    expect(bypassOf(actors({ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }, { actor_id: 99, actor_type: "Integration", bypass_mode: "always" }), APP)).toBe("no");
    expect(bypassOf(actors(), APP)).toBe("no");
    // without the App's own ID, any app in the list is taken to be relay's
    expect(bypassOf(actors({ actor_id: 99, actor_type: "Integration", bypass_mode: "always" }), {})).toBe("yes");
  });

  it("does not know when GitHub says neither, as it does to a caller without write access", () => {
    expect(bypassOf(CLI_RULESET, APP)).toBe("unknown");
  });
});

describe("readGuard", () => {
  /** GitHub as a table of answers by path; a path that is not in it is a 404. Every call is a GET, and is remembered. */
  function github(answers: Record<string, unknown>) {
    const asked: string[] = [];
    return {
      asked,
      request: async (method: string, path: string): Promise<Record<string, unknown>> => {
        asked.push(`${method} ${path}`);
        const hit = answers[path];
        if (hit instanceof Error) throw hit;
        if (hit === undefined) throw new GitHubError(`GitHub ${method} ${path}: 404`, 404);
        return hit as Record<string, unknown>;
      },
    };
  }
  const repo = { default_branch: "main", full_name: "acme/atlas-site" };

  it("asks for the default branch, its rules and who may bypass them, and nothing else when they settle it", async () => {
    const gh = github({
      "/repos/acme/atlas-site": repo,
      "/repos/acme/atlas-site/rules/branches/main?per_page=100": [...NEXT_RULES.filter((r) => r.type !== "pull_request"), pr(1, true, 31)],
      "/repos/acme/atlas-site/rulesets/31": { id: 31, enforcement: "active", current_user_can_bypass: "never" },
    });
    expect(await readGuard(gh, "acme/atlas-site", APP)).toEqual({ ok: true, repo: "acme/atlas-site", branch: "main", by: "ruleset", bypassKnown: true });
    expect(gh.asked).toEqual(["GET /repos/acme/atlas-site", "GET /repos/acme/atlas-site/rules/branches/main?per_page=100", "GET /repos/acme/atlas-site/rulesets/31"]);
  });

  it("refuses when the App may bypass the ruleset", async () => {
    const gh = github({
      "/repos/acme/atlas-site": repo,
      "/repos/acme/atlas-site/rules/branches/main?per_page=100": [pr(1, true, 31)],
      "/repos/acme/atlas-site/rulesets/31": { id: 31, current_user_can_bypass: "always" },
      "/repos/acme/atlas-site/branches/main": NEXT_BRANCH,
    });
    expect(await readGuard(gh, "acme/atlas-site", APP)).toMatchObject({ ok: false, why: "bypass" });
  });

  it("passes, not knowing about bypass, when GitHub will not show the ruleset", async () => {
    const gh = github({ "/repos/acme/atlas-site": repo, "/repos/acme/atlas-site/rules/branches/main?per_page=100": [pr(1, true, 31)] });
    expect(await readGuard(gh, "acme/atlas-site", APP)).toMatchObject({ ok: true, bypassKnown: false });
  });

  it("refuses an unprotected branch without asking for classic settings that are not there", async () => {
    const gh = github({ "/repos/acme/atlas-site": repo, "/repos/acme/atlas-site/rules/branches/main?per_page=100": [], "/repos/acme/atlas-site/branches/main": { name: "main", protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } } } });
    expect(await readGuard(gh, "acme/atlas-site", APP)).toMatchObject({ ok: false, why: "open", branch: "main" });
    expect(gh.asked).not.toContain("GET /repos/acme/atlas-site/branches/main/protection");
  });

  it("refuses classic protection the App may not read (it has no Administration permission)", async () => {
    const gh = github({
      "/repos/cli/cli": { default_branch: "trunk" },
      "/repos/cli/cli/rules/branches/trunk?per_page=100": CLI_RULES,
      "/repos/cli/cli/branches/trunk": CLI_BRANCH,
      "/repos/cli/cli/branches/trunk/protection": new GitHubError("GitHub GET /repos/cli/cli/branches/trunk/protection: 403 Resource not accessible by integration", 403),
    });
    const g = await readGuard(gh, "cli/cli", APP);
    expect(g).toMatchObject({ ok: false, why: "unreadable", branch: "trunk" });
    expect(g.ok ? "" : g.message).toMatch(/^trunk of cli\/cli has classic branch protection/);
  });

  it("believes classic protection it is allowed to read", async () => {
    const gh = github({
      "/repos/cli/cli": { default_branch: "trunk" },
      "/repos/cli/cli/rules/branches/trunk?per_page=100": CLI_RULES,
      "/repos/cli/cli/branches/trunk": CLI_BRANCH,
      "/repos/cli/cli/branches/trunk/protection": { url: "https://api.github.com/repos/cli/cli/branches/trunk/protection", required_pull_request_reviews: { dismiss_stale_reviews: true, require_code_owner_reviews: true, required_approving_review_count: 1, require_last_push_approval: true }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } },
    });
    expect(await readGuard(gh, "cli/cli", APP)).toEqual({ ok: true, repo: "cli/cli", branch: "trunk", by: "classic", bypassKnown: true });
  });

  it("asks about a branch whose name has a slash, by its path", async () => {
    const gh = github({ "/repos/acme/atlas-site": { default_branch: "release/1.x" }, "/repos/acme/atlas-site/rules/branches/release/1.x?per_page=100": [pr(1, true, 31)], "/repos/acme/atlas-site/rulesets/31": { current_user_can_bypass: "never" } });
    expect(await readGuard(gh, "acme/atlas-site", APP)).toMatchObject({ ok: true, branch: "release/1.x" });
  });

  it("refuses when GitHub cannot be asked: nobody knows what the branch allows", async () => {
    const down = github({ "/repos/acme/atlas-site": new GitHubError("GitHub GET /repos/acme/atlas-site: 502", 502) });
    const g = await readGuard(down, "acme/atlas-site", APP);
    expect(g).toMatchObject({ ok: false, why: "unreadable", branch: "" });
    expect(g.ok ? "" : g.message).toMatch(/could not ask GitHub how the default branch of acme\/atlas-site is protected \(GitHub GET \/repos\/acme\/atlas-site: 502\)/);
    const rules = github({ "/repos/acme/atlas-site": repo, "/repos/acme/atlas-site/rules/branches/main?per_page=100": new GitHubError("403", 403) });
    expect(await readGuard(rules, "acme/atlas-site", APP)).toMatchObject({ ok: false, why: "unreadable", branch: "main" });
    // an answer that is no list of rules is no rule
    const odd = github({ "/repos/acme/atlas-site": repo, "/repos/acme/atlas-site/rules/branches/main?per_page=100": { message: "moved" }, "/repos/acme/atlas-site/branches/main": NEXT_BRANCH });
    expect(await readGuard(odd, "acme/atlas-site", APP)).toMatchObject({ ok: false, why: "open" });
  });
});
