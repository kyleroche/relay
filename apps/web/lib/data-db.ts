/**
 * Postgres adapter over @relay/core. Selected by lib/data.ts when DATABASE_URL is set or RELAY_DATA=db; the handle
 * comes from lib/db.ts (one per instance, migrated on first use). Shapes are mapped here, never in pages:
 *
 *   getFeed      -> repo.listEvents (project, kind, actor, lane, before, after)
 *   getProjects  -> repo.listProjects + repo.projectStats
 *   getProject   -> repo.getProject + listDecisions(current) + listEvents + listModels
 *   getUsage     -> repo.usageSummary + repo.usageDaily; plan meters from RELAY_PLAN_METERS or unknown
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
import { fmtUntil } from "./format.ts";
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
 * Plan meters are vendor numbers the app cannot compute from the ledger. RELAY_PLAN_METERS may carry a JSON array of
 * { id, label, subscription, percentUsed, resetsAt } written by a future route or a cron; otherwise every meter is
 * unknown and the header shows nothing rather than a guess.
 */
function meters(now: number): PlanMeter[] {
  const raw = process.env.RELAY_PLAN_METERS;
  if (raw) {
    try {
      const list = JSON.parse(raw) as Array<Partial<PlanMeter>>;
      return list
        .filter((m) => m.id && m.label && m.subscription)
        .map((m) => ({
          id: m.id as string,
          label: m.label as string,
          subscription: m.subscription as Subscription,
          percentUsed: typeof m.percentUsed === "number" ? Math.max(0, Math.min(100, Math.round(m.percentUsed))) : null,
          resetsAt: m.resetsAt ?? null,
          resetsIn: m.resetsAt ? fmtUntil(m.resetsAt, now) : null,
          ...(m.note ? { note: m.note } : {}),
        }));
    } catch {
      /* fall through to unknown */
    }
  }
  return [
    { id: "max-5h", label: "5-hour", subscription: "max", percentUsed: null, resetsAt: null, resetsIn: null, note: "No plan meter source configured (RELAY_PLAN_METERS)." },
    { id: "max-week", label: "Weekly, all models", subscription: "max", percentUsed: null, resetsAt: null, resetsIn: null, note: "No plan meter source configured (RELAY_PLAN_METERS)." },
    { id: "codex-week", label: "Weekly", subscription: "codex", percentUsed: null, resetsAt: null, resetsIn: null, note: "Codex publishes no plan meter; see calls and cost equivalent instead." },
    { id: "grok-week", label: "Weekly", subscription: "grok", percentUsed: null, resetsAt: null, resetsIn: null, note: "SuperGrok publishes no plan meter." },
  ];
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
    const [rows, perDay] = await Promise.all([repo.usageSummary(db, since), repo.usageDaily(db, seriesSince)]);
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
    return { window, since, subscriptions, windows: meters(now), daily, avgCtx, avgCtxWindow: totalCalls ? Math.round(totalCtx / totalCalls) : 0 };
  },

  /** Runners are known only through the run.* events they wrote. Online = a run in progress; idle = seen within an hour. */
  async getWorkers(): Promise<Worker[]> {
    const db = await getDb();
    const rows = await repo.listEvents(db, { kind: "run.", limit: 2000 });
    const now = Date.now();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const byRunner = new Map<string, EventRow[]>();
    for (const e of rows) {
      if (!e.actor.startsWith("runner:")) continue;
      const list = byRunner.get(e.actor) ?? [];
      list.push(e);
      byRunner.set(e.actor, list);
    }
    const workers: Worker[] = [];
    for (const [actor, events] of byRunner) {
      events.sort((a, b) => a.ts.localeCompare(b.ts));
      const last = events.at(-1)!;
      const lastSeenMs = new Date(last.ts).getTime();
      const started = events.filter((e) => e.kind === "run.started");
      const lastStart = started.at(-1);
      const finished = lastStart ? events.some((e) => e.kind !== "run.started" && e.ts > lastStart.ts && (e.issue === lastStart.issue || e.issue == null)) : true;
      const current = lastStart && !finished ? { project: lastStart.project ?? "", issue: lastStart.issue ?? 0, startedAt: lastStart.ts } : null;
      const lanes = [...new Set(events.map((e) => asLane(e.lane)).filter((l): l is Lane => l !== null))];
      const payloadLabels = (last.payload.labels as unknown) ?? (lastStart?.payload.labels as unknown);
      const labels = Array.isArray(payloadLabels) ? (payloadLabels as string[]) : ["self-hosted", ...lanes.map((l) => `agent:${l}`)];
      const status: Worker["status"] = current ? "online" : now - lastSeenMs < H ? "idle" : "offline";
      workers.push({
        name: actor.slice("runner:".length),
        host: typeof last.payload.host === "string" ? last.payload.host : actor.slice("runner:".length),
        labels,
        lastSeen: last.ts,
        status,
        lanes,
        runsToday: started.filter((e) => new Date(e.ts).getTime() >= dayStart.getTime()).length,
        current,
      });
    }
    return workers.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
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
};
