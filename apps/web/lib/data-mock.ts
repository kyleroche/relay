/** DataSource over the in-memory dataset in ./mock.ts. */
import { flowScene } from "./flow-mock.ts";
import { appendEvent, dataset, MOCK_PROJECTS } from "./mock.ts";
import type {
  DataSource,
  FeedEvent,
  FeedOptions,
  ModelInfo,
  PlanMeter,
  ProjectDetail,
  ProjectSummary,
  Subscription,
  SubscriptionUsage,
  UsageSummary,
  UsageWindow,
} from "./types.ts";
import { fmtUntil, dayKey } from "./format.ts";

const H = 3_600_000;
const D = 24 * H;

const WINDOW_MS: Record<UsageWindow, number> = { "5h": 5 * H, "7d": 7 * D, "30d": 30 * D };

/** Plan caps in cost-equivalent dollars. Mock only; real meters come from the vendor. */
const CAPS = { fiveHour: 1.6, weeklyAll: 7.4, weeklyNamed: 7.2 };
const NAMED_MODEL = "anthropic/claude-fable-5-1";

function nextFiveHourReset(now: number): string {
  return new Date(Math.ceil(now / (5 * H)) * 5 * H).toISOString();
}
function nextWeeklyReset(now: number): string {
  // Weekly windows reset every 7 days from a fixed anchor (a Wednesday 14:00 UTC).
  const anchor = Date.UTC(2026, 0, 7, 14, 0, 0);
  const period = 7 * D;
  return new Date(anchor + Math.ceil((now - anchor) / period) * period).toISOString();
}

function usageRows(events: FeedEvent[], since: number): SubscriptionUsage[] {
  const map = new Map<Subscription, SubscriptionUsage & { ctxSum: number }>();
  for (const e of events) {
    if (e.kind !== "step.usage" || !e.subscription) continue;
    if (new Date(e.ts).getTime() < since) continue;
    const row = map.get(e.subscription) ?? {
      subscription: e.subscription,
      calls: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cost_equiv: 0,
      avg_ctx: 0,
      ctxSum: 0,
    };
    row.calls += 1;
    row.tokens_in += e.tokens_in;
    row.tokens_out += e.tokens_out;
    row.cache_read += e.cache_read;
    row.cost_equiv += e.cost_equiv;
    row.ctxSum += e.tokens_in + e.cache_read;
    map.set(e.subscription, row);
  }
  return [...map.values()]
    .map(({ ctxSum, ...r }) => ({ ...r, avg_ctx: r.calls ? Math.round(ctxSum / r.calls) : 0 }))
    .sort((a, b) => a.subscription.localeCompare(b.subscription));
}

function meters(events: FeedEvent[], now: number): PlanMeter[] {
  const sumCost = (since: number, pred: (e: FeedEvent) => boolean) =>
    events
      .filter((e) => e.kind === "step.usage" && new Date(e.ts).getTime() >= since && pred(e))
      .reduce((s, e) => s + e.cost_equiv, 0);
  const fiveStart = new Date(nextFiveHourReset(now)).getTime() - 5 * H;
  const weekStart = new Date(nextWeeklyReset(now)).getTime() - 7 * D;
  const max = (e: FeedEvent) => e.subscription === "max";
  const five = sumCost(fiveStart, max) / CAPS.fiveHour;
  const weekAll = sumCost(weekStart, max) / CAPS.weeklyAll;
  const weekNamed = sumCost(weekStart, (e) => max(e) && e.model === NAMED_MODEL) / CAPS.weeklyNamed;
  const r5 = nextFiveHourReset(now);
  const rw = nextWeeklyReset(now);
  const pct = (x: number) => Math.min(100, Math.round(x * 100));
  // Demo numbers (source "demo" so the UI can say so): computed from the mock ledger against made-up caps. A real
  // deployment composes these from the workers' heartbeat readings (lib/meters.ts).
  const demo = { source: "demo" as const, capturedAt: new Date(now - 4 * 60_000).toISOString(), worker: "kyrobook" };
  const none = { source: "none" as const, capturedAt: null, worker: null };
  return [
    { id: "max-5h", label: "5-hour", subscription: "max", percentUsed: pct(five), resetsAt: r5, resetsIn: fmtUntil(r5, now), ...demo },
    { id: "max-week", label: "Weekly, all models", subscription: "max", percentUsed: pct(weekAll), resetsAt: rw, resetsIn: fmtUntil(rw, now), ...demo },
    { id: "max-week-fable", label: "Weekly, Fable", subscription: "max", percentUsed: pct(weekNamed), resetsAt: rw, resetsIn: fmtUntil(rw, now), ...demo },
    { id: "codex-week", label: "Weekly", subscription: "codex", percentUsed: null, resetsAt: null, resetsIn: null, ...none, note: "Codex publishes no plan meter; see calls and cost equivalent instead." },
    { id: "grok-week", label: "Weekly", subscription: "grok", percentUsed: null, resetsAt: null, resetsIn: null, ...none, note: "SuperGrok publishes no plan meter." },
  ];
}

function openIssues(events: FeedEvent[], project: string): number {
  const open = new Set<number>();
  for (const e of events) {
    if (e.project !== project || e.issue == null) continue;
    if (e.kind === "issue.opened") open.add(e.issue);
    if (e.kind === "issue.closed") open.delete(e.issue);
  }
  return open.size;
}

function laneModels(lanes: string[], models: ModelInfo[]): ModelInfo[] {
  const ids = new Set<string>();
  for (const lane of lanes) {
    if (lane === "claude") {
      ids.add("anthropic/claude-fable-5-1");
      ids.add("anthropic/claude-opus-5");
    }
    if (lane === "codex") ids.add("openai/gpt-5.5");
    if (lane === "grok") ids.add("xai/grok-4.7");
  }
  return models.filter((m) => ids.has(m.id));
}

export const mockSource: DataSource = {
  async getFeed(opts: FeedOptions = {}): Promise<FeedEvent[]> {
    const ds = dataset();
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    let rows = ds.events;
    if (opts.project) rows = rows.filter((e) => e.project === opts.project);
    if (opts.kind) rows = rows.filter((e) => e.kind === opts.kind);
    if (opts.actor) rows = rows.filter((e) => e.actor === opts.actor);
    if (opts.lane) rows = rows.filter((e) => e.lane === opts.lane);
    if (opts.before) rows = rows.filter((e) => e.ts < (opts.before as string));
    if (opts.after) rows = rows.filter((e) => e.ts > (opts.after as string));
    return [...rows].sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id).slice(0, limit);
  },

  async getProjects(): Promise<ProjectSummary[]> {
    const ds = dataset();
    return MOCK_PROJECTS.map((p) => {
      const evs = ds.events.filter((e) => e.project === p.slug);
      return {
        slug: p.slug,
        repo: p.repo,
        stack: p.stack,
        summary: p.summary,
        lastActivity: evs.at(-1)?.ts ?? null,
        openIssues: openIssues(ds.events, p.slug),
        decisionsCount: ds.decisions.filter((d) => d.project === p.slug).length,
        digest: p.digest,
        lanes: p.lanes,
      };
    }).sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  },

  async getProject(slug: string): Promise<ProjectDetail | null> {
    const p = MOCK_PROJECTS.find((x) => x.slug === slug);
    if (!p) return null;
    const ds = dataset();
    const summary = (await mockSource.getProjects()).find((x) => x.slug === slug) as ProjectSummary;
    const events = await mockSource.getFeed({ project: slug, limit: 80 });
    return {
      ...summary,
      check_cmd: p.check_cmd,
      decisions: ds.decisions.filter((d) => d.project === slug).sort((a, b) => b.valid_from.localeCompare(a.valid_from)),
      events,
      models: laneModels(p.lanes, ds.models),
    };
  },

  async getUsage(window: UsageWindow): Promise<UsageSummary> {
    const ds = dataset();
    const now = Date.now();
    const since = now - WINDOW_MS[window];
    const subscriptions = usageRows(ds.events, since);
    const days = window === "30d" ? 30 : 7;
    const daily: UsageSummary["daily"] = [];
    const avgCtx: UsageSummary["avgCtx"] = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(now - i * D);
      dayStart.setHours(0, 0, 0, 0);
      const key = dayKey(dayStart.toISOString());
      const dayEvents = ds.events.filter((e) => e.kind === "step.usage" && dayKey(e.ts) === key);
      const row: UsageSummary["daily"][number] = { day: key };
      for (const e of dayEvents) {
        if (!e.subscription) continue;
        row[e.subscription] = (row[e.subscription] ?? 0) + e.cost_equiv;
      }
      daily.push(row);
      const ctx = dayEvents.reduce((s, e) => s + e.tokens_in + e.cache_read, 0);
      avgCtx.push({ day: key, avg_ctx: dayEvents.length ? Math.round(ctx / dayEvents.length) : 0, calls: dayEvents.length });
    }
    const windowCalls = ds.events.filter((e) => e.kind === "step.usage" && new Date(e.ts).getTime() >= since);
    const avgCtxWindow = windowCalls.length
      ? Math.round(windowCalls.reduce((s, e) => s + e.tokens_in + e.cache_read, 0) / windowCalls.length)
      : 0;
    return { window, since: new Date(since).toISOString(), subscriptions, windows: meters(ds.events, now), daily, avgCtx, avgCtxWindow };
  },

  async getWorkers() {
    return dataset().workers;
  },

  /** Tasks need a database; the demo dataset has none (the tasks page says so). */
  async getTasks() {
    return [];
  },

  async getModels() {
    return dataset().models;
  },

  async writeEvent(event) {
    return appendEvent(event);
  },

  async getAssets(opts = {}) {
    let rows = dataset().assets;
    if (opts.project) rows = rows.filter((a) => a.project === opts.project);
    if (opts.status) rows = rows.filter((a) => a.status === opts.status);
    if (opts.kind) rows = rows.filter((a) => a.kind === opts.kind);
    if (opts.issue !== undefined) rows = rows.filter((a) => a.issue === opts.issue);
    if (opts.pr !== undefined) rows = rows.filter((a) => a.pr === opts.pr);
    // pending first, then newest first: the same order the database adapter returns
    return [...rows].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.created_at.localeCompare(a.created_at)).slice(0, Math.min(opts.limit ?? 100, 500));
  },

  async getAsset(id) {
    const ds = dataset();
    const asset = ds.assets.find((a) => a.id === id);
    if (!asset) return null;
    // the version chain: walk to the root, then collect every row whose parent is in the chain
    const byId = new Map(ds.assets.map((a) => [a.id, a]));
    let root = asset;
    while (root.parent_id && byId.has(root.parent_id)) root = byId.get(root.parent_id)!;
    const chain = [root];
    for (let i = 0; i < chain.length; i++) for (const a of ds.assets) if (a.parent_id === chain[i]!.id) chain.push(a);
    const repo = MOCK_PROJECTS.find((p) => p.slug === asset.project)?.repo;
    const task_url = repo ? (asset.pr ? `https://github.com/${repo}/pull/${asset.pr}` : asset.issue ? `https://github.com/${repo}/issues/${asset.issue}` : null) : null;
    return {
      asset,
      versions: chain.sort((a, b) => a.version - b.version).map((v) => ({ id: v.id, version: v.version, status: v.status, created_at: v.created_at, created_by: v.created_by, thumb_url: v.thumb_url })),
      task_url,
    };
  },

  async reviewAsset(id, review) {
    const ds = dataset();
    const a = ds.assets.find((x) => x.id === id);
    if (!a) return null;
    const now = new Date().toISOString();
    a.status = review.decision;
    a.reviewed_by = review.by;
    a.reviewed_at = now;
    a.review_note = review.note ?? null;
    a.expires_at = review.decision === "rejected" ? new Date(Date.now() + 30 * D).toISOString() : null;
    appendEvent({
      kind: "asset.reviewed",
      actor: review.by,
      project: a.project,
      repo: MOCK_PROJECTS.find((p) => p.slug === a.project)?.repo ?? null,
      issue: a.issue,
      pr: a.pr,
      summary: `${review.decision}: ${a.title}${review.note ? ` — ${review.note}` : ""}`,
      url: `/assets/${a.id}`,
      payload: { asset_id: a.id, decision: review.decision, note: review.note ?? null, version: a.version },
    });
    if (review.decision === "rejected" && review.note) {
      ds.decisions.push({ id: 1000 + ds.decisions.length, project: a.project ?? "", text: `Rejected "${a.title}" (v${a.version}): ${review.note}`, source: "review", source_ref: a.id, valid_from: now });
    }
    return a;
  },

  async publishAsset(id, by) {
    const ds = dataset();
    const a = ds.assets.find((x) => x.id === id);
    if (!a) return null;
    // Mock mode has no Blob store; pretend the copy happened so the flow can be demoed end to end.
    a.status = "published";
    a.public_url = `https://public.example-blob.vercel-storage.com/${a.project}/${a.id}/${encodeURIComponent(a.title.toLowerCase().replace(/\s+/g, "-"))}`;
    a.expires_at = null;
    appendEvent({ kind: "asset.published", actor: by, project: a.project, issue: a.issue, pr: a.pr, url: a.public_url, summary: `published: ${a.title}`, payload: { asset_id: a.id, public_url: a.public_url, version: a.version } });
    return a;
  },

  async getFlow() {
    // the scripted scene (lib/flow-mock.ts) over the dataset's workers: one task moves every 8 s, by the clock
    return flowScene(Date.now(), dataset().workers);
  },
};
