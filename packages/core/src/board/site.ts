/**
 * What a hosted relay does on the board besides what any caller does (docs/ARCHITECTURE.md, "The site and the board"):
 *
 *   who         the site acts as its deployment whoever asked, so a write it makes for someone carries them as a
 *               profile (`actorProfile`): the board then shows who opened, approved or closed a task. Those profiles
 *               are never relay's own (`RELAY_PROFILE`), so nothing a caller's words say is believed as data.
 *   ledger      the queues' events as rows of relay's own feed (`syncLedger`): a model call becomes `step.usage`, a
 *               run `run.started` / `run.finished` / `run.failed`, a task's turns `task.*`. The board keeps a task's
 *               changes for 30 days; the feed is the durable copy, and the usage page is a view over it. It reads from
 *               a cursor kept in the database, so a watcher's wake-up and a page load are the same call and neither
 *               can skip an event.
 *   brief       the memory envelope for a new task, posted in its thread as `brief.md` (`postBrief`), so a worker
 *               needs nothing from the site but the board.
 *   merges      a pull request merged on GitHub settles the task that waits on it (`settleMerged`).
 *
 * What the site does to a task for a person or a bot, and the rules it applies first, are in board/desk.ts.
 */
import type { Board, BoardEventView, GrantView, MessageView } from "@vercel/board";
import type { Db } from "../db/client.ts";
import { writeEvent, type EventInput, type EventRow } from "../db/events.ts";
import { getSetting, putSetting } from "../db/settings.ts";
import type { BoardSession } from "./client.ts";
import { HOLD, isBranchOf, LABEL, parsePullUrl, projectOfChannel, RELAY_MESSAGE, splitTaskText, taskRef, WORK_SUBTREE } from "./mapping.ts";
import { blocksOf, isTrustedActor, RELAY_PROFILE, RELEASE_SCHEMA, RUN_SCHEMA, TASK_SCHEMA, USAGE_SCHEMA, withoutBlocks, type ReleaseBlock, type RunBlock, type TaskBlock, type UsageBlock } from "./schemas.ts";
import { listTasks, settleTask, type BoardTask } from "./tasks.ts";

/** The profile a site's own data goes out on (a gate release, an eval that could not run): one of relay's, so workers believe it. */
export const SITE_PROFILE = `${RELAY_PROFILE}site`;
/** The profile a site's brief is posted as. It is also the brief watcher's ID, so the watcher and the site are one author. */
export const BRIEF_PROFILE = `${RELAY_PROFILE}brief`;
/** The profile a site opens a task as when GitHub is what asked. No person's or bot's profile can be this (`actorProfile`). */
export const INTAKE_PROFILE = "github";

/**
 * The profile the site writes as for someone: `human:kyleroche` is `human-kyleroche`, `bot:grok-bot` is
 * `bot-grok-bot`. Always `human-`, `bot-` or `x-` first, so it is never one of relay's own profiles or the intake's.
 * A token minted through OAuth is the same bot as one of that name minted by hand (`bot:oauth:grok-bot`). A profile
 * holds letters, digits and hyphens only, so a name that is spelled with anything else, or is too long, carries a
 * hash of the exact name: two different names never share a profile.
 */
export function actorProfile(actor: string): string {
  const i = actor.indexOf(":");
  const kind = i > 0 && (actor.slice(0, i) === "human" || actor.slice(0, i) === "bot") ? actor.slice(0, i) : "x";
  const name = (kind === "x" ? actor : actor.slice(i + 1)).replace(/^oauth:/, "");
  const clean = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  const plain = `${kind}-${clean}`;
  if (clean === name && plain.length <= 32) return plain;
  return `${plain.slice(0, 27).replace(/-+$/, "")}-${taskRef(`${kind}:${name}`).slice(0, 4)}`;
}

type By = { actor: string; principal: string; profile: string | null };

/** The profile a write was made as. A local board's in-process client is its own principal, named for the profile. */
const profileOf = (by: Pick<By, "actor" | "profile">): string | null => by.profile ?? /^board:client:(.+)$/.exec(by.actor)?.[1] ?? null;

/** Whether a write was made by this principal or a profile of it. */
const isOf = (by: Pick<By, "actor" | "principal">, principal: string): boolean => by.principal === principal || by.actor.startsWith(`${principal}:`);

/** Whether the site wrote a message for this actor (`bot:grok-bot`, `human:kyleroche`): it was written as that actor's profile. */
export const writtenAs = (m: Pick<MessageView, "by">, actor: string): boolean => profileOf(m.by) === actorProfile(actor);

/**
 * Who wrote something on the board, as the feed names actors: `human:`, `bot:`, `runner:` or `agent:`. A profile
 * says `human:<name>` or `bot:<name>` only when the site itself wrote it; anyone can name a profile of their own
 * `human-kyle`, and that is an agent of theirs, not Kyle.
 */
export function feedActor(by: By | undefined, handle: string | null | undefined, site: string): string {
  if (!by) return "agent:board";
  const p = profileOf(by) ?? "";
  const name = handle || by.principal.split(":").pop() || by.principal;
  if (isOf(by, site)) {
    const made = /^(human|bot)-(.+)$/.exec(p);
    if (made) return `${made[1]}:${made[2]}`;
    if (p === INTAKE_PROFILE) return "bot:github";
  }
  if (p.startsWith(RELAY_PROFILE)) return `runner:${p.slice(RELAY_PROFILE.length)}`;
  if (p) return `agent:${name}/${p}`;
  return by.principal.startsWith("vercel:user:") || by.principal.startsWith("board:user") ? `human:${name}` : `agent:${name}`;
}

const SUBSCRIPTIONS = new Set(["max", "codex", "grok", "gateway"]);

/** A count as the feed's columns hold it: a whole number from 0 up, whatever a block said. */
const count = (n: unknown, max = Number.MAX_SAFE_INTEGER): number => (typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(0, Math.round(n)), max) : 0);
/** A cost in dollars, to the six decimals the column keeps. */
const dollars = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.round(Math.min(Math.max(0, n), 999_999) * 1e6) / 1e6 : 0);
const words = (v: unknown, max: number): string => String(v ?? "").slice(0, max);

/**
 * The feed rows one board event stands for; none for an event outside a project's queue. Pure. Usage, a run and a
 * gate release count only from a trusted author, as everywhere; a task's own turns are the board's facts and count
 * from anyone. `site` is the site's own principal, which decides what a profile's name means (`feedActor`).
 */
export function ledgerRows(event: BoardEventView, trusted: readonly string[], site: string): EventInput[] {
  const m = event.message;
  const project = m ? projectOfChannel(m.channel) : undefined;
  if (!m || !project) return [];
  const root = m.re ?? m.id;
  const base = { ts: event.createdAt, project, payload: { task: root } };

  if (event.type === "message.posted") {
    if (m.re === null) return [];
    const rows: EventInput[] = [];
    if (isTrustedActor(m.by.actor, trusted)) {
      blocksOf<UsageBlock>(m, USAGE_SCHEMA).forEach((u, i) => {
        const model = u.model ? words(u.model, 200) : null;
        rows.push({
          ...base,
          kind: "step.usage",
          actor: `runner:${words(u.worker, 100)}`,
          summary: `${u.kind === "run" ? words(u.lane, 40) : u.kind === "step" ? `step ${words(u.step ?? "?", 40)}` : u.kind}${model ? ` (${model})` : ""}`,
          lane: words(u.lane, 40),
          model,
          subscription: u.billing === "gateway" ? "gateway" : u.subscription && SUBSCRIPTIONS.has(u.subscription) ? u.subscription : null,
          tokens_in: count(u.tokens_in),
          tokens_out: count(u.tokens_out),
          cache_read: count(u.cache_read),
          cache_write: count(u.cache_write),
          cost_equiv: dollars(u.cost_equiv),
          duration_ms: count(u.duration_ms, 2_147_483_647),
          payload: { task: root, kind: u.kind, billing: u.billing, ...(u.step ? { step: u.step } : {}), ...(u.outcome ? { outcome: u.outcome } : {}) },
          dedupe_key: `board:${m.id}:usage:${i}`,
        });
      });
      blocksOf<RunBlock>(m, RUN_SCHEMA).forEach((r, i) => {
        const pr = r.pr && parsePullUrl(r.pr.url) ? r.pr : undefined;
        rows.push({
          ...base,
          kind: r.outcome === "failed" ? "run.failed" : "run.finished",
          actor: `runner:${words(r.worker, 100)}`,
          summary: `${words(r.lane, 40)}: ${words(r.outcome, 40)}${pr ? ` ${pr.repo}#${pr.number}` : ""}`,
          lane: words(r.lane, 40),
          repo: pr?.repo ?? null,
          pr: pr ? count(pr.number, 2_147_483_647) : null,
          url: pr?.url ?? null,
          payload: { task: root, conclusion: r.outcome, ...(r.branch ? { branch: r.branch } : {}), ...(r.eval_task ? { eval_task: r.eval_task } : {}) },
          dedupe_key: `board:${m.id}:run:${i}`,
        });
      });
      if (blocksOf<ReleaseBlock>(m, RELEASE_SCHEMA).length) {
        // relay's own profile wrote this line, so the name in it is the site's word for who asked
        const asked = /^Released by (\S+)\./.exec(m.text)?.[1];
        rows.push({ ...base, kind: "task.released", actor: asked ?? feedActor(m.by, m.author?.handle, site), summary: "Released from the gate for the text as it stands", dedupe_key: `board:${m.id}:release` });
      }
    }
    // a note a person or a bot left with a send-back; an eval's findings are a note too, written by a worker
    if (m.labels?.[LABEL.relay] === RELAY_MESSAGE.note && !(profileOf(m.by) ?? "").startsWith(RELAY_PROFILE)) {
      const first = withoutBlocks(m.text).split("\n").find((l) => l.trim()) ?? "";
      rows.push({ ...base, kind: "task.changes_requested", actor: feedActor(m.by, m.author?.handle, site), summary: `Sent back: ${first}`.slice(0, 300), dedupe_key: `board:${m.id}:note` });
    }
    return rows;
  }

  if (!m.task || m.re !== null) return [];
  const by = "by" in event.payload ? (event.payload.by as By | undefined) : undefined;
  const lane = m.labels?.[LABEL.lane] ?? null;
  const title = splitTaskText(withoutBlocks(m.text)).title || m.id;
  const step = blocksOf<TaskBlock>(m, TASK_SCHEMA)[0]?.step;
  const row = (kind: string, summary: string, extra: Record<string, unknown> = {}): EventInput[] => [
    { ...base, kind, actor: feedActor(by, event.actor?.handle ?? (by && m.by.actor === by.actor ? m.author?.handle : null), site), summary: summary.slice(0, 300), lane, payload: { task: root, title, ...extra }, dedupe_key: `board:${m.id}:${event.type}:${event.cursor}` },
  ];
  switch (event.type) {
    case "task.created":
      return row("task.created", title, { lane, ...(m.labels?.[LABEL.model] ? { model: m.labels[LABEL.model] } : {}), ...(step ? { step } : {}) });
    case "task.claimed":
      // a worker's claim is a run starting; anyone else's (the opener holding a task back while it sets it up) is not
      if (!by || !(profileOf(by) ?? "").startsWith(RELAY_PROFILE)) return [];
      return row("run.started", `${lane ?? "a lane"} took ${title}`, { until: event.payload.until });
    case "task.blocked":
      return event.payload.kind === HOLD.gate ? row("task.held", `${title}: ${event.payload.reason ?? "held at the gate"}`, { reason: event.payload.reason }) : [];
    case "task.completed":
      // a step's own task (an eval) ending is not an approval; its run row says how it went
      return step ? [] : row("task.approved", `${title}: ${event.payload.result ?? "done"}`, { result: event.payload.result });
    case "task.canceled":
      return row("task.closed", `${title}: ${event.payload.reason ?? "closed"}`, { reason: event.payload.reason });
    case "task.reopened":
      return row("task.requeued", title);
    default:
      return [];
  }
}

/** Where the ledger has read the board's feed to (a setting, so every instance and every trigger share it). */
export const LEDGER_CURSOR = "board.ledger.cursor";

export interface LedgerSync {
  /** Board events read this time. */
  events: number;
  /** The feed rows written, oldest first (a row already there is not written again). */
  written: EventRow[];
  /** Events whose rows the database refused: each left a `ledger.skipped` row in their place. */
  skipped: number;
  cursor: string | null;
  /** False when it stopped at `maxPages` with more to read: call again. */
  caught_up: boolean;
}

/**
 * Bring the feed up to the board: read the queues' events from the stored cursor, write their rows, move the cursor.
 * Safe to call from anywhere at any time: rows are written once by their dedupe key, and the cursor only ever moves
 * to where the board said the page ended. The first call has no cursor and takes the board's own summary of its last
 * 100 events, which leaves out a hold that was since lifted; every call after reads from the cursor, which is every
 * event. Rows are not rewritten later: usage from a login that was not yet in the site's trusted owners stays
 * uncounted.
 *
 * One event the database refuses must not stop every event after it, so its rows are dropped and a `ledger.skipped`
 * row says so. When that row cannot be written either, the database is what is wrong: the call throws and the cursor
 * stays where it was.
 */
export async function syncLedger(db: Db, s: BoardSession, opts: { maxPages?: number } = {}): Promise<LedgerSync> {
  let cursor = (await getSetting(db, LEDGER_CURSOR)) ?? null;
  const out: LedgerSync = { events: 0, written: [], skipped: 0, cursor, caught_up: false };
  for (let page = 0; page < (opts.maxPages ?? 20); page++) {
    const r = cursor ? await s.board.poll({ channel: WORK_SUBTREE, after: cursor, wait: 0 }) : await s.board.poll({ channel: WORK_SUBTREE, last: 100 });
    for (const event of r.events) {
      try {
        for (const input of ledgerRows(event, s.from, s.me.principal)) {
          const row = await writeEvent(db, input);
          if (row) out.written.push(row);
        }
      } catch (e) {
        out.skipped++;
        const project = event.message ? (projectOfChannel(event.message.channel) ?? null) : null;
        await writeEvent(db, { kind: "ledger.skipped", actor: "bot:relay", project, summary: `A ${event.type} on the board could not be recorded: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), payload: { task: event.message?.re ?? event.message?.id ?? null, cursor: event.cursor }, dedupe_key: `board:skipped:${event.cursor}` });
      }
    }
    out.events += r.events.length;
    if (r.cursor && r.cursor !== cursor) {
      cursor = r.cursor;
      await putSetting(db, LEDGER_CURSOR, cursor);
    }
    if (!r.events.length) {
      out.caught_up = true;
      break;
    }
  }
  return { ...out, cursor };
}

/**
 * Post a task's brief in its thread as `brief.md`: a worker that trusts the poster hands it to the lane instead of
 * compiling one from its own memory (work/job.ts `threadBrief`). The post has an ID made from the task, so the same
 * author posting again changes nothing, and what anyone else posted is not looked at.
 */
export async function postBrief(board: Board, id: string, text: string): Promise<void> {
  const file = await board.upload({ data: new TextEncoder().encode(text), name: "brief.md", type: "text/markdown" });
  await board.reply(id, { text: "The brief for this task (brief.md): what relay's memory holds that bears on it.", attachments: [file], labels: { [LABEL.relay]: RELAY_MESSAGE.brief }, noSync: true, id: `relay-brief:${id}` });
}

/**
 * A pull request was merged on GitHub: complete the task that waits on it, whether a person was to review it or a
 * step was still looking at it. Only a task whose hold names this pull request, and only when its head is a branch
 * relay pushed for that task. Undefined when no task waits on it.
 */
export async function settleMerged(board: Board, pull: { url: string; head_ref: string; merge_sha?: string | null }): Promise<BoardTask | undefined> {
  const pr = parsePullUrl(pull.url);
  if (!pr) return undefined;
  const waiting = (await listTasks(board, { state: "open", limit: 1000 })).find((t) => t.pr?.url === pr.url && isBranchOf(pull.head_ref, t.id));
  if (!waiting) return undefined;
  return settleTask(board, waiting.id, `merged ${pr.repo}#${pr.number} on GitHub${pull.merge_sha ? ` in ${pull.merge_sha.slice(0, 7)}` : ""}`);
}

/**
 * Let a Vercel project's production deployment run relay's site on this board: everything in the queues, so it can
 * lift a hold or call off a task someone else opened (a project's deployments start with read, post and label only).
 * Answers the actor that deployment writes as, which is what a worker names to take the tasks the site opens.
 * Asking again finds the grant that is there. It takes `manage` on the queues to make one.
 */
export async function grantSite(b: Board, project: string): Promise<{ actor: string; granted: boolean }> {
  const named = (g: GrantView): string | undefined => {
    if (g.can[WORK_SUBTREE] !== "all") return undefined;
    for (const p of g.principals) if (p.kind === "project" && (p.projectId === project || p.name === project)) return p.projectId;
    return undefined;
  };
  let id = (await b.grants()).map(named).find(Boolean);
  const granted = !id;
  if (!id) id = named((await b.createGrant({ principals: [{ kind: "project", project, environments: ["production"] }], can: { [WORK_SUBTREE]: "all" } })).grant);
  if (!id) throw new Error(`the board made the grant but did not say which project '${project}' is`);
  return { actor: `vercel:project:${id}:production`, granted };
}

