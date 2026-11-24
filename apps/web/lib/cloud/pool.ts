/**
 * The pool: `runApproved()` starts one Vercel Sandbox for each queued task that carries a trusted grant for a paid
 * run, is not already being started, and whose project still allows it. Nothing else in the site starts a sandbox.
 *
 * It is called after a person approves a run (app/tasks/actions.ts) and from the throttled place the ledger sync runs
 * (lib/board-watch.ts), so a start that did not come up is tried again without anyone asking. If one of the owner's
 * own workers claims the task first there is nothing to start: the task is no longer queued.
 *
 * A start is marked in the task's thread before the sandbox is made (core's cloud/start.ts has the rule), so two
 * instances that look at once start one sandbox, and a grant is one run: what may have run is never started again
 * by itself.
 *
 * Which threads are read: the queued tasks whose root carries the label `cloud=approved`, which the approve action
 * sets. The label only narrows the read; a task is started for the grant in its thread, never for a label, and the
 * pool takes the label off once nothing more will follow (no grant for the text as it stands, or a grant that is
 * spent). A grant made elsewhere (the CLI) is found by a wider look every five minutes, which then puts the label on.
 *
 * Before a start, the site asks GitHub again whether the repository's default branch takes only approved pull
 * requests (lib/cloud/guard.ts): a grant written with the CLI was never checked, and a rule can be taken off after
 * an approval. Without the rule nothing is started, and the thread says what to turn on.
 */
import { randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import {
  ANY_LANE,
  board,
  CLOUD_APPROVED,
  CLOUD_GITHUB_PERMISSIONS,
  CLOUD_LABEL,
  CLOUD_LANE,
  cloudFailedKey,
  cloudBoardCan,
  cloudFailedText,
  cloudGrantOf,
  cloudMarksOf,
  cloudNames,
  cloudRunPlan,
  cloudStart,
  cloudStartKey,
  cloudStartText,
  cloudTimeoutMs,
  grantedAccess,
  parseCloudMark,
  type CloudNames,
  type CloudRunPlan,
  type GitHubApp,
} from "@relay/core";
import { siteBoard } from "../board.ts";
import { githubApp } from "../github-app.ts";
import { dataMode } from "../mode.ts";
import { projectProfile, type ProfileRead } from "../profile.ts";
import { cloudConfig, cloudProblem, type CloudConfig } from "./config.ts";
import { repoGuard, type BranchGuard } from "./guard.ts";
import { CloudLaunchError, githubTokenProblem, launch, type CloudSecrets } from "./launch.ts";

/** One start, as its credentials are asked for: who the sandbox is, where it works, and what it may do on the board. */
export interface CloudStartAsk {
  names: CloudNames;
  repo: string;
  /** The task's own queue and the workers channel (`cloudBoardCan`). */
  can: Record<string, string[]>;
}

export interface PoolDeps {
  session: board.BoardSession;
  config: CloudConfig;
  profile(repo: string | null): Promise<ProfileRead>;
  /** Whether the repository's default branch takes only approved pull requests, asked now. */
  guard(repo: string): Promise<BranchGuard>;
  /** The three credentials for one start, and how long the shortest-lived of them is still good for. */
  secrets(ask: CloudStartAsk): Promise<{ secrets: CloudSecrets; lifeMs?: number }>;
  launch(plan: CloudRunPlan, secrets: CloudSecrets): Promise<void>;
  now(): number;
  /** Also look at queued tasks without the label, for a grant made outside the site. */
  wide?: boolean;
}

export interface CloudPass {
  started: string[];
  /** Starts that did not come up, with why (also in each task's thread). */
  failed: Array<{ task: string; why: string }>;
}

/** One pass starts at most this many: each takes a minute or two of the function that runs it. */
const STARTS_PER_PASS = 2;
const WIDE_EVERY_MS = 5 * 60_000;
const WIDE_MAX = 50;

declare global {
  // eslint-disable-next-line no-var
  var __relayCloudWideAt: number | undefined;
}

const takesCloud = (t: board.BoardTask): boolean => t.state === "queued" && (t.lane === CLOUD_LANE || t.lane === ANY_LANE);

/** When a JWT among a policy's credentials expires, in epoch ms; undefined when none of them is a JWT. */
function boardExpiry(allow: CloudSecrets["board"]["allow"]): number | undefined {
  const ends: number[] = [];
  for (const rule of Object.values(allow).flat()) {
    for (const t of rule.transform ?? []) {
      const bearer = /^Bearer\s+(\S+)$/.exec(t.headers?.authorization ?? "")?.[1];
      try {
        const exp = bearer ? decodeJwt(bearer).exp : undefined;
        if (exp) ends.push(exp * 1000);
      } catch {
        // not a JWT: its lifetime is its issuer's to know
      }
    }
  }
  return ends.length ? Math.min(...ends) : undefined;
}

/** What `siteSecrets` needs of the site: its board, its GitHub App and the gateway's key. */
export interface SecretSources {
  session: { board: Pick<board.Board, "sandboxPolicy">; from: readonly string[] };
  app: Pick<GitHubApp, "repoToken">;
  gateway: string;
}

/**
 * The credentials of one start, none of which enters the sandbox: the board as this deployment under the worker's
 * profile and held to the task's own queue, a new installation token of the site's GitHub App for the one repository
 * with the permissions a run needs and no other, and the gateway's key. The gateway's key is the one credential
 * that is not this start's alone: it is the site's, and the same in every run.
 */
export async function siteSecrets(from: SecretSources, ask: CloudStartAsk, now: number = Date.now()): Promise<{ secrets: CloudSecrets; lifeMs?: number }> {
  // minted for this start and never cached: one repository, three permissions, good for an hour
  const minted = await from.app.repoToken(ask.repo, { permissions: CLOUD_GITHUB_PERMISSIONS });
  if (!minted.permissions) throw new Error("GitHub did not say what the installation token may do, so it is not handed to a sandbox");
  const wider = githubTokenProblem({ githubPermissions: { ...CLOUD_GITHUB_PERMISSIONS } }, minted.permissions);
  if (wider) throw new Error(`${wider}, so it is not handed to a sandbox`);
  const policy = await from.session.board.sandboxPolicy({ profile: { name: ask.names.profile }, can: ask.can as Record<string, Array<"read" | "post" | "react" | "label">> });
  const ends = [boardExpiry(policy.allow), minted.expiresAt].filter((t): t is number => t !== undefined && Number.isFinite(t));
  return { secrets: { board: { allow: policy.allow, env: policy.env }, github: { repo: ask.repo, token: minted.token, permissions: minted.permissions }, gateway: from.gateway, from: from.session.from }, ...(ends.length ? { lifeMs: Math.min(...ends) - now } : {}) };
}

/** The site's own sources, read when a start asks: a deployment without the key or the App starts nothing. */
async function siteSources(session: board.BoardSession): Promise<SecretSources> {
  const gateway = process.env.RELAY_GATEWAY_TOKEN?.trim();
  if (!gateway) throw new Error("RELAY_GATEWAY_TOKEN, the model gateway's key, is not set on this deployment");
  const app = await githubApp();
  if (!app) throw new Error("the site has no GitHub App, so it cannot give the sandbox access to one repository (GitHub App, in the avatar menu)");
  return { session, app, gateway };
}

async function siteDeps(): Promise<PoolDeps> {
  const session = await siteBoard();
  const now = Date.now();
  const wide = globalThis.__relayCloudWideAt === undefined || now - globalThis.__relayCloudWideAt >= WIDE_EVERY_MS;
  if (wide) globalThis.__relayCloudWideAt = now;
  return { session, config: cloudConfig(), profile: (repo) => projectProfile(repo), guard: (repo) => repoGuard(repo, { fresh: true }), secrets: async (ask) => siteSecrets(await siteSources(session), ask), launch: (plan, secrets) => launch(plan, secrets), now: Date.now, wide };
}

/** The queued tasks whose root says a paid run was approved. */
async function hinted(b: board.Board): Promise<board.BoardTask[]> {
  const page = await b.tasks.list({ channel: board.WORK_SUBTREE, state: "ready", label: { [CLOUD_LABEL]: CLOUD_APPROVED }, limit: 50 });
  return page.tasks.map((t) => board.toTask(t.message));
}

const said = (e: unknown, secrets: readonly string[]): string => secrets.reduce((text, secret) => (secret ? text.split(secret).join("[credential]") : text), e instanceof Error ? e.message : String(e));

/**
 * Start what is approved and not started. With no argument it is the site's own pass, and does nothing in mock mode
 * or on a deployment that is not set up for paid runs; tests pass their own board, credentials and launcher.
 */
export async function runApproved(given?: PoolDeps): Promise<CloudPass> {
  const out: CloudPass = { started: [], failed: [] };
  if (!given && (dataMode() !== "db" || cloudProblem())) return out;
  const deps = given ?? (await siteDeps());
  const { session, config } = deps;
  const own = session.board.as(board.SITE_PROFILE);
  const log = { labels: { [board.LABEL.relay]: board.RELAY_MESSAGE.log }, noSync: true };

  const candidates = new Map((await hinted(session.board)).map((t) => [t.id, t]));
  if (deps.wide) for (const t of await board.listTasks(session.board, { state: "queued", limit: WIDE_MAX })) if (takesCloud(t) && !candidates.has(t.id)) candidates.set(t.id, t);

  for (const task of candidates.values()) {
    if (out.started.length + out.failed.length >= STARTS_PER_PASS) break;
    if (!takesCloud(task)) continue;
    const thread = await session.board.thread(task.id);
    const found = cloudGrantOf(thread, session.from);
    // a grant above the deployment's limit (made elsewhere, or before the limit came down) is not acted on
    const grant = found && found.capUsd <= config.limits.maxCapUsd ? found : undefined;
    const decision = grant ? cloudStart(cloudMarksOf(thread, session.from), grant.id, deps.now()) : undefined;
    // the label says "look here again": on while a start is due or coming up, off once nothing more will follow
    const live = !!decision && ("start" in decision || decision.wait === "starting");
    const labelled = task.labels[CLOUD_LABEL] === CLOUD_APPROVED;
    if (live !== labelled) await session.board.label(task.id, live ? { set: { [CLOUD_LABEL]: CLOUD_APPROVED } } : { unset: [CLOUD_LABEL] }).catch(() => undefined);
    if (!grant || !decision || !("start" in decision)) continue;
    const read = await deps.profile(task.repo);
    if (!read.profile || read.profile.cloud === "never") continue;

    const n = decision.start;
    const names = cloudNames(task.id, { grant: grant.id, n });
    const nonce = randomBytes(4).toString("hex");
    const mark = await own.reply(task.id, { text: cloudStartText({ grant: grant.id, n, sandbox: names.sandbox, capUsd: grant.capUsd, timeoutMs: cloudTimeoutMs(grant.capUsd), nonce }), ...log, id: cloudStartKey(task.id, grant.id, n) });
    // the board keeps the first mark posted under the key: when it is not this one, another instance has this start
    if (parseCloudMark(board.withoutBlocks(mark.text))?.nonce !== nonce) continue;

    const known: string[] = [process.env.RELAY_GATEWAY_TOKEN?.trim() ?? ""];
    try {
      // one of the owner's workers may have taken it while this was reading: then there is nothing to start
      const state = (await session.board.thread(task.id)).message.task?.state;
      if (state !== "ready") throw new Error(`the task is ${state ?? "gone"} now, so nothing was started`);
      if (!task.repo) throw new Error("the task names no repository to work in");
      if (!task.project) throw new Error("the task is in no project's queue, so there is no queue to hold the sandbox to");
      // the lane's token can push: nothing starts unless GitHub itself keeps unreviewed work off the default branch
      const guard = await deps.guard(task.repo);
      if (!guard.ok) throw new Error(guard.message);
      const { secrets, lifeMs } = await deps.secrets({ names, repo: task.repo, can: cloudBoardCan(task.project) });
      known.push(secrets.gateway, secrets.github.token);
      const plan = cloudRunPlan({
        task,
        cap: grant.capUsd,
        relayVersion: config.relayVersion,
        hosts: grantedAccess(read.profile, board.grantsOf(thread, session.from).sets).hosts,
        gatewayUrl: config.gatewayUrl,
        start: { grant: grant.id, n },
        ...(lifeMs !== undefined ? { credentialLifeMs: lifeMs } : {}),
      });
      await deps.launch(plan, secrets);
      out.started.push(task.id);
    } catch (e) {
      const why = said(e, known);
      out.failed.push({ task: task.id, why });
      console.error(`[relay] cloud run of ${task.id}, start ${n}: ${why}`);
      // only a start known not to be running is marked as one to try again
      const uncertain = e instanceof CloudLaunchError && e.uncertain;
      const text = uncertain ? `Cloud run, start ${n}: ${why}`.slice(0, 900) : cloudFailedText({ grant: grant.id, n, why });
      await own.reply(task.id, { text, ...log, ...(uncertain ? {} : { id: cloudFailedKey(task.id, grant.id, n) }) }).catch(() => undefined);
    }
  }
  return out;
}

/** The site's pass, for `after()`: a failure is logged and the next pass tries again. */
export async function runApprovedQuietly(): Promise<void> {
  try {
    await runApproved();
  } catch (e) {
    console.error(`[relay] cloud runs: ${board.describeBoardError(e)}`);
  }
}
