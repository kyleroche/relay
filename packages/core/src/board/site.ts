/**
 * What a hosted relay does on the board besides what any caller does (docs/ARCHITECTURE.md, "The site and the board"):
 *
 *   who         the site acts as its deployment whoever asked, so each write carries the asker as a profile
 *               (`actorProfile`): the board then shows who opened, approved or closed a task.
 *   ledger      the queues' events as rows of relay's own feed (`syncLedger`): a model call becomes `step.usage`, a
 *               run `run.started` / `run.finished` / `run.failed`, a task's turns `task.*`. The board keeps a task's
 *               changes for 30 days; the feed is the durable copy, and the usage page is a view over it. It reads from
 *               a cursor kept in the database, so a watcher's wake-up, a cron and a page load are all the same call
 *               and none of them can skip an event.
 *   brief       the memory envelope for a new task, posted in its thread as `brief.md` (`postBrief`), so a worker
 *               needs nothing from the site but the board.
 *   merges      a pull request merged on GitHub settles the task that waits on it (`settleMerged`).
 */
import type { Board, BoardEventView, MessageView } from "@vercel/board";
import type { Db } from "../db/client.ts";
import { writeEvent, type EventInput } from "../db/events.ts";
import { getSetting, putSetting } from "../db/settings.ts";
import type { BoardSession } from "./client.ts";
import { HOLD, isBranchOf, LABEL, parsePullUrl, projectOfChannel, RELAY_MESSAGE, splitTaskText, taskRef, WORK_SUBTREE } from "./mapping.ts";
import { blocksOf, isTrustedActor, RUN_SCHEMA, USAGE_SCHEMA, withoutBlocks, type RunBlock, type UsageBlock } from "./schemas.ts";
import { listTasks, settleTask, type BoardTask } from "./tasks.ts";

/**
 * The profile the site writes as for someone: `human:kyleroche` is `human-kyleroche`, `bot:grok-bot` is
 * `bot-grok-bot`. A profile is a letter, then up to 31 letters, digits and hyphens; a longer name keeps its start and
 * a hash of the whole.
 */
export function actorProfile(actor: string): string {
  const clean = actor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const named = /^[a-z]/.test(clean) ? clean : `x-${clean || "unknown"}`;
  return named.length <= 32 ? named : `${named.slice(0, 27).replace(/-+$/, "")}-${taskRef(named).slice(0, 4)}`;
}

/** The profile a write was made as. A local board's in-process client is its own principal, named for the profile. */
const profileOf = (by: { actor: string; profile: string | null }): string | null => by.profile ?? /^board:client:(.+)$/.exec(by.actor)?.[1] ?? null;

/** Who wrote something on the board, as the feed names actors: `human:`, `bot:`, `runner:` or `agent:`. */
export function feedActor(by: { actor: string; principal: string; profile: string | null } | undefined, handle?: string | null): string {
  if (!by) return "agent:board";
  const p = profileOf(by) ?? "";
  const made = /^(human|bot)-(.+)$/.exec(p);
  if (made) return `${made[1]}:${made[2]}`;
  if (p.startsWith("relay-")) return `runner:${p.slice("relay-".length)}`;
  const name = handle || by.principal.split(":").pop() || by.principal;
  if (p) return `agent:${name}/${p}`;
  return by.principal.startsWith("vercel:user:") || by.principal.startsWith("board:user") ? `human:${name}` : `agent:${name}`;
}

const SUBSCRIPTIONS = new Set(["max", "codex", "grok", "gateway"]);

/**
 * The feed rows one board event stands for; none for an event outside a project's queue. Pure. A usage or run block
 * counts only from a trusted author, as everywhere; a task's own turns are the board's facts and count from anyone.
 */
export function ledgerRows(event: BoardEventView, trusted: readonly string[]): EventInput[] {
  const m = event.message;
  const project = m ? projectOfChannel(m.channel) : undefined;
  if (!m || !project) return [];
  const root = m.re ?? m.id;
  const base = { ts: event.createdAt, project, payload: { task: root } };
  const by = "by" in event.payload ? (event.payload.by as MessageView["by"] | undefined) : undefined;

  if (event.type === "message.posted") {
    if (m.re === null || !isTrustedActor(m.by.actor, trusted)) return [];
    const rows: EventInput[] = [];
    blocksOf<UsageBlock>(m, USAGE_SCHEMA).forEach((u, i) => {
      rows.push({
        ...base,
        kind: "step.usage",
        actor: `runner:${u.worker}`,
        summary: `${u.kind === "run" ? u.lane : u.kind === "step" ? `step ${u.step ?? "?"}` : u.kind}${u.model ? ` (${u.model})` : ""}`,
        lane: u.lane,
        model: u.model,
        subscription: u.billing === "gateway" ? "gateway" : u.subscription && SUBSCRIPTIONS.has(u.subscription) ? u.subscription : null,
        tokens_in: u.tokens_in,
        tokens_out: u.tokens_out,
        cache_read: u.cache_read,
        cache_write: u.cache_write,
        cost_equiv: u.cost_equiv,
        duration_ms: u.duration_ms,
        payload: { task: root, kind: u.kind, billing: u.billing, ...(u.step ? { step: u.step } : {}), ...(u.outcome ? { outcome: u.outcome } : {}) },
        dedupe_key: `board:${m.id}:usage:${i}`,
      });
    });
    blocksOf<RunBlock>(m, RUN_SCHEMA).forEach((r, i) => {
      const failed = r.outcome === "failed";
      rows.push({
        ...base,
        kind: failed ? "run.failed" : "run.finished",
        actor: `runner:${r.worker}`,
        summary: `${r.lane}: ${r.outcome}${r.pr ? ` ${r.pr.repo}#${r.pr.number}` : ""}`,
        lane: r.lane,
        repo: r.pr?.repo ?? null,
        pr: r.pr?.number ?? null,
        url: r.pr?.url ?? null,
        payload: { task: root, conclusion: r.outcome, ...(r.branch ? { branch: r.branch } : {}), ...(r.eval_task ? { eval_task: r.eval_task } : {}) },
        dedupe_key: `board:${m.id}:run:${i}`,
      });
    });
    return rows;
  }

  if (!m.task || m.re !== null) return [];
  const lane = m.labels?.[LABEL.lane] ?? null;
  const title = splitTaskText(withoutBlocks(m.text)).title || m.id;
  const row = (kind: string, summary: string, extra: Record<string, unknown> = {}): EventInput[] => [
    { ...base, kind, actor: feedActor(by, null), summary: summary.slice(0, 300), lane, payload: { task: root, title, ...extra }, dedupe_key: `board:${event.type}:${event.cursor}` },
  ];
  switch (event.type) {
    case "task.created":
      return row("task.created", title, { lane, ...(m.labels?.[LABEL.model] ? { model: m.labels[LABEL.model] } : {}) });
    case "task.claimed":
      // a worker's claim is a run starting; anyone else's (the opener holding a task back while it sets it up) is not
      if (!by || !(profileOf(by) ?? "").startsWith("relay-")) return [];
      return row("run.started", `${lane ?? "a lane"} took ${title}`, { until: event.payload.until });
    case "task.blocked":
      return event.payload.kind === HOLD.gate ? row("task.held", `${title}: ${event.payload.reason ?? "held at the gate"}`, { reason: event.payload.reason }) : [];
    case "task.completed":
      return row("task.approved", `${title}: ${event.payload.result ?? "done"}`, { result: event.payload.result });
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
  /** Feed rows written (a row already there is not written again). */
  rows: number;
  cursor: string | null;
  /** False when it stopped at `maxPages` with more to read: call again. */
  caught_up: boolean;
}

/**
 * Bring the feed up to the board: read the queues' events from the stored cursor, write their rows, move the cursor.
 * Safe to call from anywhere at any time: rows are written once by their dedupe key, and the cursor only ever moves
 * to where the board said the page ended. The first call starts from the feed's last 100 events.
 */
export async function syncLedger(db: Db, s: BoardSession, opts: { maxPages?: number } = {}): Promise<LedgerSync> {
  let cursor = (await getSetting(db, LEDGER_CURSOR)) ?? null;
  const out: LedgerSync = { events: 0, rows: 0, cursor, caught_up: false };
  for (let page = 0; page < (opts.maxPages ?? 20); page++) {
    const r = cursor ? await s.board.poll({ channel: WORK_SUBTREE, after: cursor, wait: 0 }) : await s.board.poll({ channel: WORK_SUBTREE, last: 100 });
    for (const event of r.events) for (const row of ledgerRows(event, s.from)) if (await writeEvent(db, row)) out.rows++;
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
 * Post a task's brief in its thread as `brief.md`, once: a worker that trusts the poster hands it to the lane instead
 * of compiling one from its own memory (work/job.ts `threadBrief`). False when the thread already has one.
 */
export async function postBrief(board: Board, id: string, text: string): Promise<boolean> {
  const thread = await board.thread(id);
  if (thread.replies.some((m) => !m.deleted && m.labels?.[LABEL.relay] === RELAY_MESSAGE.brief)) return false;
  const file = await board.upload({ data: new TextEncoder().encode(text), name: "brief.md", type: "text/markdown" });
  await board.reply(id, { text: "The brief for this task (brief.md): what relay's memory holds that bears on it.", attachments: [file], labels: { [LABEL.relay]: RELAY_MESSAGE.brief }, noSync: true, id: `relay-brief:${id}` });
  return true;
}

/**
 * A pull request was merged on GitHub: complete the task in review that waits on it. Only a task whose hold names
 * this pull request, and only when its head is a branch relay pushed for that task. Undefined when no task waits on it.
 */
export async function settleMerged(board: Board, pull: { url: string; head_ref: string; merge_sha?: string | null }): Promise<BoardTask | undefined> {
  const pr = parsePullUrl(pull.url);
  if (!pr) return undefined;
  const waiting = (await listTasks(board, { state: "review" })).find((t) => t.pr?.url === pr.url && isBranchOf(pull.head_ref, t.id));
  if (!waiting) return undefined;
  return settleTask(board, waiting.id, `merged ${pr.repo}#${pr.number} on GitHub${pull.merge_sha ? ` in ${pull.merge_sha.slice(0, 7)}` : ""}`);
}
