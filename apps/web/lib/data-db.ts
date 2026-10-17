/**
 * Postgres adapter over @relay/core. Selected by lib/data.ts when DATABASE_URL is set or RELAY_DATA=db; the handle
 * comes from lib/db.ts (one per instance, migrated on first use). Shapes are mapped here, never in pages:
 *
 *   getFeed      -> repo.listEvents (project, kind, actor, lane, before, after)
 *   getProjects  -> repo.listProjects + repo.projectStats
 *   getProject   -> repo.getProject + listDecisions(current) + listEvents + listModels
 *   getUsage     -> repo.usageSummary + repo.usageDaily; plan meters from RELAY_PLAN_METERS, else the workers' heartbeat readings (lib/meters.ts)
 *   getWorkers   -> the last run.* events per runner:* actor (until a heartbeat exists)
 *   getModels    -> repo.listModels
 *   writeEvent   -> repo.writeEvent (dedupe_key makes redeliveries a no-op)
 *   assets       -> repo.listAssets / getAsset / listVersions / reviewAsset / publishAsset through lib/assets.ts
 */
import { repo, type AssetRow } from "@relay/core";

type EventRow = repo.EventRow;
type ModelRow = repo.ModelRow;
import { getStore, taskUrl, toAsset, toVersion } from "./assets.ts";
import { getDb } from "./db.ts";
import type { EventKind } from "./events.ts";
import type { FlowProject, FlowSnapshot, FlowTask } from "./flow.ts";
import { composeMeters } from "./meters.ts";
import type {
  Asset,
  AssetDetail,
  AssetListOptions,
  AssetReview,
  DataSource,
  FeedEvent,
  FeedOptions,
  Lane,
  ModelInfo,
  NewEvent,
  PlanMeter,
  ProjectDetail,
  ProjectSummary,
  Subscription,
  TaskListOptions,
  TaskView,
  UsageSummary,
  UsageWindow,
  Worker,
} from "./types.ts";

const H = 3_600_000;
const D = 24 * H;
const WINDOW_MS: Record<UsageWindow, number> = { "5h": 5 * H, "7d": 7 * D, "30d": 30 * D };
const LANES: Lane[] = ["claude", "codex", "grok"];
const SUBSCRIPTIONS: Subscription[] = ["max", "codex", "grok", "gateway"];

const asLane = (v: string | null): Lane | null => (LANES.includes(v as Lane) ? (v as Lane) : null);
const asSubscription = (v: string | null): Subscription | null => (SUBSCRIPTIONS.includes(v as Subscription) ? (v as Subscription) : null);

export function toFeedEvent(e: EventRow): FeedEvent {
  return { ...e, kind: e.kind as EventKind, lane: asLane(e.lane), subscription: asSubscription(e.subscription) };
}

function toModel(m: ModelRow): ModelInfo {
  const staleDays = m.stale_days ?? 30;
  let status: ModelInfo["status"] = "pending";
  if (m.onboarded_at) status = Date.now() - new Date(m.onboarded_at).getTime() > staleDays * D ? "stale" : "ready";
  return { id: m.id, provider: m.provider, lanes: m.lanes, onboarded_at: m.onboarded_at, guidance_count: m.guidance_count ?? 0, skill_count: m.skill_count ?? 0, stale_days: staleDays, status };
}

/** Which models a project's lanes use. Models carry their lane names; a project's lanes come from its events. */
function laneModels(lanes: Lane[], models: ModelInfo[]): ModelInfo[] {
  if (!lanes.length) return [];
  return models.filter((m) => m.lanes.some((l) => lanes.includes(l as Lane)));
}

/**
 * Plan meters are vendor numbers the app cannot compute from the ledger (lib/meters.ts): RELAY_PLAN_METERS overrides,
 * then the freshest reading the workers reported with their heartbeats (Claude Code's own rate limits, saved by relay's
 * status line), else unknown with a note that says how to get one.
 */
async function meters(db: Awaited<ReturnType<typeof getDb>>, now: number): Promise<PlanMeter[]> {
  const workers = await repo.workerViews(db, now);
  return composeMeters({ override: process.env.RELAY_PLAN_METERS, workers, now });
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const dbSource: DataSource = {
  async getFeed(opts: FeedOptions = {}): Promise<FeedEvent[]> {
    const db = await getDb();
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = await repo.listEvents(db, {
      ...(opts.project ? { project: opts.project } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.actor ? { actor: opts.actor } : {}),
      ...(opts.lane ? { lane: opts.lane } : {}),
      ...(opts.before ? { before: opts.before } : {}),
      ...(opts.after ? { after: opts.after } : {}),
      limit,
    });
    return rows.map(toFeedEvent);
  },

  async getProjects(): Promise<ProjectSummary[]> {
    const db = await getDb();
    const [projects, stats] = await Promise.all([repo.listProjects(db), repo.projectStats(db)]);
    const byslug = new Map(stats.map((s) => [s.slug, s]));
    return projects
      .map((p) => {
        const s = byslug.get(p.slug);
        return {
          slug: p.slug,
          repo: p.repo ?? "",
          stack: p.stack,
          summary: p.summary,
          lastActivity: s?.last_activity ?? p.updated_at,
          openIssues: s?.open_issues ?? 0,
          decisionsCount: s?.decisions ?? 0,
          digest: { digested: s?.digested ?? 0, total: s?.total ?? 0 },
          lanes: (s?.lanes ?? []).map(asLane).filter((l): l is Lane => l !== null),
        };
      })
      .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  },

  async getProject(slug: string): Promise<ProjectDetail | null> {
    const db = await getDb();
    const p = await repo.getProject(db, slug);
    if (!p) return null;
    const [summary, decisions, events, models] = await Promise.all([
      dbSource.getProjects().then((all) => all.find((x) => x.slug === slug)),
      repo.listDecisions(db, slug, { current: true, limit: 200 }),
      repo.listEvents(db, { project: slug, limit: 80 }),
      repo.listModels(db),
    ]);
    if (!summary) return null;
    return {
      ...summary,
      check_cmd: p.check_cmd,
      decisions: decisions.map((d) => ({ id: d.id, project: d.project ?? slug, text: d.text, source: d.source ?? "unknown", source_ref: d.source_ref, valid_from: d.valid_from })),
      events: events.map(toFeedEvent),
      models: laneModels(summary.lanes, models.map(toModel)),
    };
  },

  async getUsage(window: UsageWindow): Promise<UsageSummary> {
    const db = await getDb();
    const now = Date.now();
    const since = new Date(now - WINDOW_MS[window]).toISOString();
    const days = window === "30d" ? 30 : 7;
    const seriesSince = new Date(now - days * D).toISOString();
    const [rows, perDay, windows] = await Promise.all([repo.usageSummary(db, since), repo.usageDaily(db, seriesSince), meters(db, now)]);
    const subscriptions = rows
      .filter((r) => asSubscription(r.subscription))
      .map((r) => ({ subscription: r.subscription as Subscription, calls: r.calls, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cache_read: r.cache_read, cost_equiv: r.cost_equiv, avg_ctx: Math.round(r.avg_ctx) }));
    const daily: UsageSummary["daily"] = [];
    const avgCtx: UsageSummary["avgCtx"] = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = utcDay(now - i * D);
      const dayRows = perDay.filter((r) => r.day === key);
      const row: UsageSummary["daily"][number] = { day: key };
      let calls = 0;
      let ctx = 0;
      for (const r of dayRows) {
        const sub = asSubscription(r.subscription);
        if (sub) row[sub] = (row[sub] ?? 0) + r.cost_equiv;
        calls += r.calls;
        ctx += r.tokens_in + r.cache_read;
      }
      daily.push(row);
      avgCtx.push({ day: key, avg_ctx: calls ? Math.round(ctx / calls) : 0, calls });
    }
    const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
    const totalCtx = rows.reduce((s, r) => s + r.tokens_in + r.cache_read, 0);
    return { window, since, subscriptions, windows, daily, avgCtx, avgCtxWindow: totalCalls ? Math.round(totalCtx / totalCalls) : 0 };
  },

  /**
   * Workers are the machines that ran `relay work` (the `workers` table, docs/WORKERS.md): state from last_seen, the
   * current task from the live claim, runs today from their run.started rows. Runners that only ever reported through
   * GitHub Actions (no registration) still appear from their run.* events, so the older path keeps showing up.
   */
  async getWorkers(): Promise<Worker[]> {
    const db = await getDb();
    const now = Date.now();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const [views, rows] = await Promise.all([repo.workerViews(db, now), repo.listEvents(db, { kind: "run.", limit: 2000 })]);
    const byRunner = new Map<string, EventRow[]>();
    for (const e of rows) {
      if (!e.actor.startsWith("runner:")) continue;
      const list = byRunner.get(e.actor) ?? [];
      list.push(e);
      byRunner.set(e.actor, list);
    }
    const runsToday = (name: string) => (byRunner.get(`runner:${name}`) ?? []).filter((e) => e.kind === "run.started" && new Date(e.ts).getTime() >= dayStart.getTime()).length;
    const workers: Worker[] = views.map((w) => ({
      name: w.name,
      host: w.host || w.name,
      labels: w.labels,
      lastSeen: w.last_seen,
      status: w.state,
      lanes: w.lanes.map(asLane).filter((l): l is Lane => l !== null),
      version: w.version,
      runsToday: runsToday(w.name),
      pollMs: w.poll_ms,
      current: w.current ? { project: w.current.project, issue: w.current.issue, startedAt: w.current.claimed_at, taskId: w.current.task_id, leaseUntil: w.current.lease_until } : null,
    }));
    const known = new Set(workers.map((w) => `runner:${w.name}`));
    for (const [actor, events] of byRunner) {
      if (known.has(actor)) continue;
      events.sort((a, b) => a.ts.localeCompare(b.ts));
      const last = events.at(-1)!;
      const lastSeenMs = new Date(last.ts).getTime();
      const started = events.filter((e) => e.kind === "run.started");
      const lastStart = started.at(-1);
      const finished = lastStart ? events.some((e) => e.kind !== "run.started" && e.ts > lastStart.ts && (e.issue === lastStart.issue || e.issue == null)) : true;
      const current = lastStart && !finished ? { project: lastStart.project ?? "", issue: lastStart.issue ?? 0, startedAt: lastStart.ts } : null;
      const lanes = [...new Set(events.map((e) => asLane(e.lane)).filter((l): l is Lane => l !== null))];
      const payloadLabels = (last.payload.labels as unknown) ?? (lastStart?.payload.labels as unknown);
      workers.push({
        name: actor.slice("runner:".length),
        host: typeof last.payload.host === "string" ? last.payload.host : actor.slice("runner:".length),
        labels: Array.isArray(payloadLabels) ? (payloadLabels as string[]) : [],
        lastSeen: last.ts,
        status: current ? "online" : now - lastSeenMs < H ? "idle" : "offline",
        lanes,
        version: "",
        runsToday: runsToday(actor.slice("runner:".length)),
        pollMs: null,
        current,
      });
    }
    return workers.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  },

  async getTasks(opts: TaskListOptions = {}): Promise<TaskView[]> {
    return repo.listTaskViews(await getDb(), opts);
  },

  async getModels(): Promise<ModelInfo[]> {
    const db = await getDb();
    return (await repo.listModels(db)).map(toModel);
  },

  async writeEvent(event: NewEvent): Promise<FeedEvent | null> {
    const db = await getDb();
    const row = await repo.writeEvent(db, { ...event, ts: event.ts });
    return row ? toFeedEvent(row) : null;
  },

  async getAssets(opts: AssetListOptions = {}): Promise<Asset[]> {
    const db = await getDb();
    const rows = await repo.listAssets(db, { ...opts, limit: Math.min(Math.max(opts.limit ?? 100, 1), 500) });
    return Promise.all(rows.map((r) => toAsset(r)));
  },

  async getAsset(id: string): Promise<AssetDetail | null> {
    const db = await getDb();
    const row = await repo.getAsset(db, id);
    if (!row) return null;
    const [versions, project] = await Promise.all([repo.listVersions(db, id), row.project ? repo.getProject(db, row.project) : undefined]);
    return { asset: await toAsset(row), versions: await Promise.all(versions.map((v) => toVersion(v))), task_url: taskUrl(project?.repo, row) };
  },

  async reviewAsset(id: string, review: AssetReview): Promise<Asset | null> {
    const db = await getDb();
    let row: AssetRow;
    try {
      row = await repo.reviewAsset(db, id, { decision: review.decision, by: review.by, note: review.note ?? null });
    } catch (e) {
      if (e instanceof repo.AssetNotFoundError) return null;
      throw e;
    }
    return toAsset(row);
  },

  async publishAsset(id: string, by: string): Promise<Asset | null> {
    const db = await getDb();
    const row = await repo.getAsset(db, id);
    if (!row) return null;
    // Local store, or Blob without BLOB_PUBLIC_READ_WRITE_TOKEN, throws PublishUnsupportedError; the route maps it to 501.
    const url = await getStore().publish(row.storage_key, { contentType: row.mime });
    return toAsset(await repo.publishAsset(db, id, url, { by }));
  },

  /**
   * The flow map, from the task state cache (packages/core/src/db/task-state.ts): one query over `tasks` returns
   * everything in motion (queued, claimed, running, review), done tasks for 90 s after the merge so a client sees them
   * reach Merged and fade, and failed ones for a day, so the siding shows what stalled today without turning into an
   * archive. Each row already carries its state, station and the moment it got there, written by the fold that ran
   * when the last event, claim or release landed; nothing is folded here. Expired leases are released first so a
   * vanished worker's task reads `queued`, as the fold would have said. Workers come from getWorkers (the same rows
   * the workers page shows). /api/flow memoizes the result per instance for a few seconds.
   */
  async getFlow(): Promise<FlowSnapshot> {
    const db = await getDb();
    const now = Date.now();
    await repo.expireLeases(db, now);
    const [rows, workers] = await Promise.all([repo.flowTasks(db, { now, limit: 200 }), dbSource.getWorkers()]);
    const tasks: FlowTask[] = rows.map((r) => ({
      id: r.id,
      project: r.project,
      repo: r.repo,
      issue: r.issue,
      title: r.title ?? `#${r.issue}`,
      lane: r.lane,
      state: r.state,
      station: r.station,
      since: r.since,
      pr: r.pr,
      pr_url: r.pr_url,
      preview_state: r.preview_state,
      preview_url: r.preview_url,
      runner: r.runner,
      ...(r.cost != null ? { cost: r.cost } : {}),
      ...(r.state === "failed" && r.last_error ? { error: r.last_error } : {}),
    }));
    // one stop per project with a task that is not done; the repo from the project row, else from the task itself
    const projects: FlowProject[] = [];
    for (const r of rows) {
      if (r.state === "done" || projects.some((p) => p.slug === r.project)) continue;
      projects.push({ slug: r.project, repo: r.project_repo ?? r.repo });
    }
    projects.sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      ts: new Date(now).toISOString(),
      projects,
      workers: workers.map((w) => {
        // registered workers carry the claim's task id; an Actions-only runner names project and issue, so look the task up
        const c = w.current;
        const taskId = c ? (c.taskId ?? tasks.find((t) => t.project === c.project && t.issue === c.issue)?.id ?? null) : null;
        return { name: w.name, lanes: w.lanes, state: w.status, current: taskId ? { task_id: taskId } : null, last_seen: w.lastSeen };
      }),
      tasks,
    };
  },
};
