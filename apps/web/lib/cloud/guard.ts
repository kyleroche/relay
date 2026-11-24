/**
 * The one check that stops a paid run from putting its own work on the default branch: before a run is approved, and
 * again before it is started, the site asks GitHub whether that branch takes changes only through a pull request
 * that someone else approved. If GitHub does not say so, the run is refused, with what to turn on.
 *
 * Why it has to be GitHub's rule. The lane in a paid run can run any code, and the sandbox's firewall signs its
 * requests to the task's repository with a token that may push and may open pull requests. That same permission
 * (`contents: write`) is what a merge and a push to any branch take. The firewall refuses the REST merge paths, but
 * it cannot see inside a GraphQL request or a git push (lib/cloud/launch.ts). So without a rule on the branch, a
 * fooled lane can `git push origin HEAD:main`, or merge its own pull request with a GraphQL mutation.
 *
 * What is asked for, and why each part:
 *
 *   a pull request is required           a direct push to the branch is refused by GitHub
 *   with at least 1 approval             the token's own identity opened the pull request, and GitHub lets nobody
 *                                        approve their own
 *   of the most recent push              else the lane could push onto somebody else's open pull request (a host
 *                                        worker's, which the owner's own GitHub account opened), approve it as the
 *                                        App, which did not open that one, and merge it
 *   and relay's App cannot bypass it     the sandbox's token is the App's. A rule the App may bypass is no rule here
 *
 * The consequence for the owner is real and is said in the refusal: with such a rule, relay's own Approve (which
 * merges as the same App) merges a pull request only after a person approved it on GitHub.
 *
 * What GitHub is asked (REST, as the site's App):
 *
 *   GET /repos/{o}/{r}                               `default_branch`
 *   GET /repos/{o}/{r}/rules/branches/{branch}       the active ruleset rules for the branch: items with `type`,
 *                                                    `parameters`, `ruleset_id` (needs Metadata: read)
 *   GET /repos/{o}/{r}/rulesets/{id}                 `current_user_can_bypass` (always, pull_requests_only, never,
 *                                                    exempt) and, for a caller that may write the ruleset,
 *                                                    `bypass_actors`
 *   GET /repos/{o}/{r}/branches/{branch}             `protection.enabled`: classic branch protection is on
 *   GET /repos/{o}/{r}/branches/{branch}/protection  its settings. Needs Administration: read, which relay's App
 *                                                    does not ask for, so this is usually a 403 and a classic rule
 *                                                    cannot be believed: the refusal says to use a ruleset
 *
 * `branchGuard` is the decision, pure, over those answers; `readGuard` asks. Nothing here is called against GitHub
 * by a test.
 */
import { GitHubError, type GitHubClient } from "@relay/core";
import { githubAppConfig } from "../github-app.ts";
import { siteGitHub } from "../integrations.ts";

/** One item of `GET /repos/{o}/{r}/rules/branches/{branch}`. */
export interface BranchRule {
  type: string;
  parameters?: Record<string, unknown>;
  ruleset_id?: number;
}

/** Whether the caller that asked (the site's App) may bypass a rule: GitHub said no, said yes, or did not say. */
export type Bypass = "no" | "yes" | "unknown";

/** `GET /repos/{o}/{r}/branches/{branch}/protection`, the parts read here. */
export interface ClassicProtection {
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    require_last_push_approval?: boolean;
    bypass_pull_request_allowances?: { users?: unknown[]; teams?: unknown[]; apps?: Array<{ id?: number; slug?: string }> };
  };
}

export interface GuardFacts {
  repo: string;
  /** The default branch. */
  branch: string;
  rules: readonly BranchRule[];
  /** By ruleset ID, for the rulesets that require a pull request. One GitHub did not answer for is absent: unknown. */
  bypass: Readonly<Record<number, Bypass>>;
  /** Classic branch protection: off, on with its settings, or on with settings the site may not read. */
  classic: "off" | "unreadable" | ClassicProtection;
  /** relay's GitHub App, to find it in a list of who may bypass. */
  app: { id?: number; slug?: string };
}

export type BranchGuard =
  | {
      ok: true;
      repo: string;
      branch: string;
      /** Where the rule is. */
      by: "ruleset" | "classic";
      /** False when GitHub did not say whether relay's App may bypass the rule; the docs tell the owner to keep it off the list. */
      bypassKnown: boolean;
    }
  | {
      ok: false;
      repo: string;
      /** Empty when the repository itself could not be read. */
      branch: string;
      /**
       * open: nothing requires a pull request. no-review: one is required, with no approval. last-push: an approval,
       * but not of the most recent push. bypass: the rule is there and relay's App may bypass it. unreadable: GitHub
       * did not say (classic protection the App may not read, or a failed read).
       */
      why: "open" | "no-review" | "last-push" | "bypass" | "unreadable";
      /** For a person: what is wrong and what to turn on. */
      message: string;
    };

interface Requirement {
  approvals: number;
  lastPush: boolean;
  bypass: Bypass;
  by: "ruleset" | "classic";
}

/** What to turn on, the same in every refusal. */
export function guardFix(repo: string, branch: string): string {
  return `In ${repo}, Settings, Rules, Rulesets, add a ruleset for ${branch || "the default branch"} that requires a pull request before merging, with at least 1 approval and "Require approval of the most recent reviewable push", and leave relay's GitHub App off its bypass list. relay's Approve then merges a pull request only after someone approved it on GitHub.`;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Rules of one kind stack, and the strictest setting applies: over the requirements a caller cannot get around. */
const strictest = (all: readonly Requirement[]): { approvals: number; lastPush: boolean } => ({ approvals: Math.max(0, ...all.map((r) => r.approvals)), lastPush: all.some((r) => r.lastPush) });
const enough = (r: { approvals: number; lastPush: boolean }): boolean => r.approvals >= 1 && r.lastPush;

/** Whether the default branch is safe to hand a paid run's token to, or why not. Pure. */
export function branchGuard(f: GuardFacts): BranchGuard {
  const requirements: Requirement[] = f.rules
    .filter((r) => r.type === "pull_request")
    .map((r) => ({ approvals: count(r.parameters?.required_approving_review_count), lastPush: r.parameters?.require_last_push_approval === true, bypass: (typeof r.ruleset_id === "number" ? f.bypass[r.ruleset_id] : undefined) ?? "unknown", by: "ruleset" as const }));
  if (typeof f.classic === "object") {
    const reviews = f.classic.required_pull_request_reviews;
    if (reviews) {
      const apps = reviews.bypass_pull_request_allowances?.apps ?? [];
      // an app in the list that cannot be told from relay's is taken to be relay's
      const listed = apps.some((a) => (a.id === undefined && a.slug === undefined) || (f.app.id !== undefined && a.id === f.app.id) || (!!f.app.slug && a.slug === f.app.slug));
      requirements.push({ approvals: count(reviews.required_approving_review_count), lastPush: reviews.require_last_push_approval === true, bypass: listed ? "yes" : "no", by: "classic" });
    }
  }

  const held = requirements.filter((r) => r.bypass !== "yes");
  if (enough(strictest(held))) {
    const alone = (by: Requirement["by"]): boolean => enough(strictest(held.filter((r) => r.by === by)));
    return { ok: true, repo: f.repo, branch: f.branch, by: alone("ruleset") || !alone("classic") ? "ruleset" : "classic", bypassKnown: enough(strictest(requirements.filter((r) => r.bypass === "no"))) };
  }

  const no = (why: Exclude<BranchGuard, { ok: true }>["why"], what: string): BranchGuard => ({ ok: false, repo: f.repo, branch: f.branch, why, message: `${what} ${guardFix(f.repo, f.branch)}` });
  const lane = "a paid run's lane can run any code with a token that may push to this repository";
  if (enough(strictest(requirements))) return no("bypass", `${f.branch} of ${f.repo} requires an approved pull request, but relay's GitHub App may bypass that rule, and a paid run's token is the App's.`);
  if (f.classic === "unreadable" && !requirements.length) return no("unreadable", `${f.branch} of ${f.repo} has classic branch protection, which relay's GitHub App may not read, so relay cannot tell that it requires an approved pull request.`);
  if (!requirements.length) return no("open", `${f.branch} of ${f.repo} takes direct pushes, and ${lane}: it could push its work straight to ${f.branch}.`);
  const most = strictest(held.length ? held : requirements);
  if (most.approvals < 1) return no("no-review", `${f.branch} of ${f.repo} requires a pull request but no approval, and ${lane}: it could merge its own pull request.`);
  return no("last-push", `${f.branch} of ${f.repo} requires an approval, but not of the most recent push, and ${lane}: it could push onto someone else's open pull request, approve it as relay's App and merge it.`);
}

/** What `GET /repos/{o}/{r}/rulesets/{id}` says about the caller: `current_user_can_bypass`, else the App in `bypass_actors`, else nothing. */
export function bypassOf(ruleset: Record<string, unknown>, app: { id?: number }): Bypass {
  const said = ruleset.current_user_can_bypass;
  if (typeof said === "string") return said === "never" ? "no" : "yes";
  // returned only to a caller that may write the ruleset; when it is there, the App is in it or is not
  if (Array.isArray(ruleset.bypass_actors)) {
    const actors = ruleset.bypass_actors as Array<{ actor_id?: unknown; actor_type?: unknown }>;
    return actors.some((a) => a?.actor_type === "Integration" && (app.id === undefined || a.actor_id === app.id)) ? "yes" : "no";
  }
  return "unknown";
}

/** At most this many rulesets are asked about; a branch under more is read as far as that, the rest unknown. */
const RULESETS_ASKED = 8;

/** Ask GitHub, as the site's App, and decide. A read that fails is a refusal: nobody knows what the branch allows. */
export async function readGuard(github: Pick<GitHubClient, "request">, repo: string, app: { id?: number; slug?: string } = {}): Promise<BranchGuard> {
  let branch = "";
  try {
    const about = await github.request("GET", `/repos/${repo}`);
    if (typeof about.default_branch !== "string" || !about.default_branch) throw new Error("GitHub named no default branch");
    branch = about.default_branch;
    const at = branch.split("/").map(encodeURIComponent).join("/");

    const listed = (await github.request("GET", `/repos/${repo}/rules/branches/${at}?per_page=100`)) as unknown;
    const rules: BranchRule[] = Array.isArray(listed) ? (listed as BranchRule[]).filter((r) => r && typeof r.type === "string") : [];
    const ids = [...new Set(rules.filter((r) => r.type === "pull_request" && typeof r.ruleset_id === "number").map((r) => r.ruleset_id!))].slice(0, RULESETS_ASKED);
    const bypass: Record<number, Bypass> = {};
    for (const id of ids) {
      const ruleset = await github.request("GET", `/repos/${repo}/rulesets/${id}`).catch(() => undefined);
      if (ruleset) bypass[id] = bypassOf(ruleset, app);
    }

    let classic: GuardFacts["classic"] = "off";
    const first = branchGuard({ repo, branch, rules, bypass, classic, app });
    // classic protection is asked about only when the rulesets do not already settle it
    if (!first.ok) {
      const head = await github.request("GET", `/repos/${repo}/branches/${at}`);
      if ((head.protection as { enabled?: unknown } | undefined)?.enabled === true) {
        classic = await github.request("GET", `/repos/${repo}/branches/${at}/protection`).then(
          (p) => p as ClassicProtection,
          (e: unknown) => {
            if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) return "unreadable" as const;
            throw e;
          },
        );
      }
    }
    return classic === "off" ? first : branchGuard({ repo, branch, rules, bypass, classic, app });
  } catch (e) {
    const said = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    return { ok: false, repo, branch, why: "unreadable", message: `relay could not ask GitHub how ${branch || "the default branch"} of ${repo} is protected (${said}), so no paid run is started there. ${guardFix(repo, branch)}` };
  }
}

const TTL_MS = 60_000;

declare global {
  // eslint-disable-next-line no-var
  var __relayCloudGuards: Map<string, { at: number; read: Promise<BranchGuard> }> | undefined;
}

/**
 * The site's own answer for a repository. `fresh` asks GitHub now (an approval, a start); a page that only shows the
 * offer takes an answer up to a minute old, since every card of a project asks.
 */
export function repoGuard(repo: string | null, opts: { fresh?: boolean; now?: number } = {}): Promise<BranchGuard> {
  if (!repo) return Promise.resolve({ ok: false, repo: "", branch: "", why: "unreadable", message: "The task names no repository, so there is no branch to check and nowhere for a paid run to work." });
  const now = opts.now ?? Date.now();
  const cache = (globalThis.__relayCloudGuards ??= new Map());
  const hit = cache.get(repo);
  if (!opts.fresh && hit && now - hit.at < TTL_MS) return hit.read;
  const read = (async (): Promise<BranchGuard> => {
    const [github, resolved] = await Promise.all([siteGitHub(), githubAppConfig().catch(() => undefined)]);
    // the question "may the caller bypass" is only an answer about the sandbox's token when the caller is the App
    if (!github || github.source !== "app" || !resolved) return { ok: false, repo, branch: "", why: "unreadable", message: `The site has no GitHub App, so it can neither give a sandbox access to ${repo} nor ask how its default branch is protected (GitHub App, in the avatar menu).` };
    const id = Number(resolved.config.appId);
    return readGuard(github, repo, { ...(Number.isFinite(id) ? { id } : {}), ...(resolved.slug ? { slug: resolved.slug } : {}) });
  })().catch((e: unknown): BranchGuard => ({ ok: false, repo, branch: "", why: "unreadable", message: `relay could not ask GitHub how the default branch of ${repo} is protected: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400) }));
  cache.set(repo, { at: now, read });
  return read;
}
