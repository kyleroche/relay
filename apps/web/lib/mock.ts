/**
 * In-memory dataset for RELAY_DATA=mock. Deterministic (seeded PRNG) and anchored to
 * "now" at module load, so the feed reads like a live system. Roughly 200 events across
 * four projects, three lanes, and four principal actors (plus bot:vercel for previews).
 *
 * The dataset lives on globalThis so dev-server HMR and the webhook routes share one copy.
 */
import type { EventKind } from "./events.ts";
import type {
  Asset,
  AssetKind,
  AssetStatus,
  Decision,
  FeedEvent,
  Lane,
  ModelInfo,
  NewEvent,
  Subscription,
  Worker,
} from "./types.ts";

export interface MockProject {
  slug: string;
  repo: string;
  stack: string;
  check_cmd: string;
  summary: string;
  digest: { digested: number; total: number };
  lanes: Lane[];
}

export const MOCK_PROJECTS: MockProject[] = [
  {
    slug: "relay",
    repo: "acme/relay",
    stack: "TypeScript · pnpm · Next.js · Postgres",
    check_cmd: "pnpm -r typecheck && pnpm -r test",
    summary:
      "The harness itself: core library, CLI, memory MCP server and this web app. Issues labelled agent:* are picked up by self-hosted runners.",
    digest: { digested: 212, total: 238 },
    lanes: ["claude", "codex", "grok"],
  },
  {
    slug: "atlas-site",
    repo: "acme/atlas-site",
    stack: "Next.js · MDX · Vercel",
    check_cmd: "pnpm lint && pnpm build",
    summary:
      "Marketing and docs site. Mostly content and layout tasks; previews come from Vercel on every PR.",
    digest: { digested: 96, total: 104 },
    lanes: ["claude", "grok"],
  },
  {
    slug: "ledger-api",
    repo: "acme/ledger-api",
    stack: "Go · Postgres · Fly.io",
    check_cmd: "go vet ./... && go test ./...",
    summary:
      "Double-entry ledger service. Strict review lane: nothing merges without an approving review from a different model.",
    digest: { digested: 140, total: 181 },
    lanes: ["codex", "claude"],
  },
  {
    slug: "studio-app",
    repo: "acme/studio-app",
    stack: "Swift · SwiftUI · Xcode Cloud",
    check_cmd: "xcodebuild test -scheme Studio",
    summary:
      "iPad companion app. Runner needs a Mac with Xcode; only the studio runner carries the macos label.",
    digest: { digested: 58, total: 122 },
    lanes: ["claude"],
  },
];

const LANE_MODEL: Record<Lane, { model: string; subscription: Subscription }> = {
  claude: { model: "anthropic/claude-fable-5-1", subscription: "max" },
  codex: { model: "openai/gpt-5.5", subscription: "codex" },
  grok: { model: "xai/grok-4.7", subscription: "grok" },
};
const REVIEW_MODEL = { model: "anthropic/claude-opus-5", subscription: "max" as Subscription, lane: "claude" as Lane };

/** Gateway list prices per 1M tokens; mirrors packages/core/src/ledger/ledger.ts. */
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "anthropic/claude-fable-5-1": { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "anthropic/claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "openai/gpt-5.5": { in: 2.5, out: 10, cacheRead: 0.25, cacheWrite: 0 },
  "xai/grok-4.7": { in: 3, out: 15, cacheRead: 0.75, cacheWrite: 0 },
};

function costEquiv(model: string, tin: number, tout: number, cr: number, cw: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (tin * p.in + tout * p.out + cr * p.cacheRead + cw * p.cacheWrite) / 1_000_000;
}

const HUMAN = "human:maya";
const BOT = "bot:grok";
const RUNNER = "runner:studio";
const RUNNER_ALT = "runner:loft";
const AGENT = "agent:claude";
const VERCEL = "bot:vercel";

const TASKS: Record<string, string[]> = {
  relay: [
    "Add digest coverage bar to project list",
    "Rate-limit webhook ingest per delivery id",
    "Write RUNNERS.md for self-hosted registration",
    "Nightly consolidation should close superseded decisions",
    "Lane adapter: strip ANTHROPIC_API_KEY before spawning",
    "Feed: group events by day",
    "Onboarding gate rejects models with stale guidance",
    "Export ledger as CSV from the CLI",
  ],
  "atlas-site": [
    "Pricing page copy refresh",
    "Fix OG image on blog posts",
    "Add changelog MDX collection",
    "Dark mode flicker on first load",
    "Sitemap missing docs pages",
    "Newsletter form double-submits",
  ],
  "ledger-api": [
    "Idempotency keys for POST /transfers",
    "Migrate balances to numeric(20,6)",
    "Return RFC 9457 problem details on 4xx",
    "Nightly reconciliation job",
    "Reject postings that do not balance",
    "Add OpenTelemetry spans to repository layer",
  ],
  "studio-app": [
    "Pencil hover preview on canvas",
    "Crash on rotate while exporting",
    "Sync conflicts show stale thumbnail",
    "Keyboard shortcuts sheet",
  ],
};

const DECISIONS: Record<string, Array<{ text: string; source: string; daysAgo: number }>> = {
  relay: [
    { text: "Events are append-only; the ledger is a view over step.usage rows, never a separate table.", source: "pr", daysAgo: 9 },
    { text: "Official vendor sources only for model guidance. Community prompt guides need an allowlisted domain with a reason.", source: "human", daysAgo: 21 },
    { text: "Lanes strip ANTHROPIC_API_KEY from the environment so headless runs never bill the API instead of the subscription.", source: "claude", daysAgo: 6 },
    { text: "Webhook handlers dedupe on the GitHub delivery id; replays are a no-op, not an error.", source: "codex", daysAgo: 3 },
    { text: "Web app reads through a DataSource interface so mock and Postgres adapters are interchangeable.", source: "claude", daysAgo: 1 },
  ],
  "atlas-site": [
    { text: "MDX content lives in content/, never in app/; pages are thin loaders.", source: "pr", daysAgo: 14 },
    { text: "Theme is read from prefers-color-scheme with a cookie override to avoid first-paint flicker.", source: "grok", daysAgo: 4 },
    { text: "OG images render with next/og using the system font; no remote fonts at build.", source: "claude", daysAgo: 7 },
  ],
  "ledger-api": [
    { text: "All money is numeric(20,6); no floats anywhere in the service boundary.", source: "pr", daysAgo: 8 },
    { text: "Every mutating endpoint requires an Idempotency-Key header; replays return the stored response.", source: "codex", daysAgo: 5 },
    { text: "Errors are application/problem+json with a stable type URI per failure class.", source: "codex", daysAgo: 2 },
    { text: "Review lane for this repo always runs on a different vendor than the code lane.", source: "human", daysAgo: 30 },
  ],
  "studio-app": [
    { text: "Canvas state is a value type; undo is a stack of diffs, not snapshots.", source: "claude", daysAgo: 12 },
    { text: "Builds run only on the macos-labelled runner; other runners skip studio-app jobs.", source: "human", daysAgo: 18 },
  ],
};

const MODELS: ModelInfo[] = [
  { id: "anthropic/claude-fable-5-1", provider: "anthropic", lanes: ["code", "plan", "digest"], onboarded_at: null, guidance_count: 142, skill_count: 6, stale_days: 30, status: "ready" },
  { id: "anthropic/claude-opus-5", provider: "anthropic", lanes: ["review"], onboarded_at: null, guidance_count: 118, skill_count: 6, stale_days: 30, status: "ready" },
  { id: "openai/gpt-5.5", provider: "openai", lanes: ["code", "review"], onboarded_at: null, guidance_count: 96, skill_count: 3, stale_days: 30, status: "ready" },
  { id: "xai/grok-4.7", provider: "xai", lanes: ["code", "triage"], onboarded_at: null, guidance_count: 41, skill_count: 1, stale_days: 30, status: "stale" },
  { id: "bytedance/seedance-2.5", provider: "bytedance", lanes: ["video"], onboarded_at: null, guidance_count: 0, skill_count: 0, stale_days: 30, status: "pending" },
];

/** mulberry32: small, seeded, good enough for fixtures. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Dataset {
  now: number;
  events: FeedEvent[];
  decisions: Decision[];
  models: ModelInfo[];
  workers: Worker[];
  assets: Asset[];
  nextId: number;
}

/**
 * Mock assets. Bytes are generated on request by /api/assets/mock/<id> (SVG for images, a one-page PDF, an HTML
 * page, CSV); the video has a poster but no playable source, which is also what the viewer shows when a store
 * cannot serve bytes. Ids are fixed so links survive a reload.
 */
interface MockAssetSeed {
  id: string;
  project: string;
  issue?: number;
  pr?: number;
  title: string;
  description: string;
  kind: AssetKind;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  duration_ms?: number;
  version?: number;
  parent_id?: string;
  status: AssetStatus;
  created_by: string;
  hoursAgo: number;
  reviewed_by?: string;
  review_note?: string;
  tags: string[];
}

export const MOCK_ASSET_SEEDS: MockAssetSeed[] = [
  {
    id: "01K7A0MOCKASSET0000000001A",
    project: "atlas-site",
    issue: 118,
    title: "Pricing page hero mockup",
    description: "Second pass after the copy refresh: shorter headline, plan cards aligned to the 8px grid, dark variant included.",
    kind: "image",
    mime: "image/png",
    size: 412_338,
    width: 1600,
    height: 1000,
    version: 2,
    parent_id: "01K7A0MOCKASSET0000000001B",
    status: "pending",
    created_by: "bot:grok",
    hoursAgo: 1.4,
    tags: ["ux", "pricing"],
  },
  {
    id: "01K7A0MOCKASSET0000000001B",
    project: "atlas-site",
    issue: 118,
    title: "Pricing page hero mockup",
    description: "First pass of the pricing hero.",
    kind: "image",
    mime: "image/png",
    size: 398_120,
    width: 1600,
    height: 1000,
    version: 1,
    status: "superseded",
    created_by: "bot:grok",
    hoursAgo: 27,
    tags: ["ux", "pricing"],
  },
  {
    id: "01K7A0MOCKASSET0000000002A",
    project: "studio-app",
    issue: 73,
    title: "Onboarding flow walkthrough",
    description: "Screen recording of the new three-step onboarding on iPad, exported from the simulator.",
    kind: "video",
    mime: "video/mp4",
    size: 18_422_911,
    width: 1668,
    height: 2388,
    duration_ms: 42_600,
    status: "pending",
    created_by: "runner:studio",
    hoursAgo: 3.2,
    tags: ["onboarding"],
  },
  {
    id: "01K7A0MOCKASSET0000000003A",
    project: "atlas-site",
    pr: 97,
    title: "Changelog page render",
    description: "Static render of /changelog from the preview build, for a look at the MDX collection layout before merge.",
    kind: "html",
    mime: "text/html",
    size: 61_204,
    status: "pending",
    created_by: "agent:codex",
    hoursAgo: 5.6,
    tags: ["changelog"],
  },
  {
    id: "01K7A0MOCKASSET0000000004A",
    project: "ledger-api",
    pr: 141,
    title: "Idempotency design note",
    description: "Two pages on the Idempotency-Key storage shape and the replay window, written for the review lane.",
    kind: "pdf",
    mime: "application/pdf",
    size: 88_410,
    status: "approved",
    created_by: "agent:claude",
    hoursAgo: 30,
    reviewed_by: "human:maya",
    tags: ["design"],
  },
  {
    id: "01K7A0MOCKASSET0000000005A",
    project: "atlas-site",
    issue: 102,
    title: "Dark mode palette",
    description: "Proposed dark surfaces and accent ramp.",
    kind: "image",
    mime: "image/png",
    size: 120_033,
    width: 1200,
    height: 800,
    status: "rejected",
    created_by: "bot:grok",
    hoursAgo: 52,
    reviewed_by: "human:maya",
    review_note: "Accent is too saturated against zinc-950; keep one hue and lower chroma to match the light theme.",
    tags: ["ux", "theme"],
  },
  {
    id: "01K7A0MOCKASSET0000000006A",
    project: "ledger-api",
    issue: 133,
    title: "Reconciliation sample export",
    description: "CSV produced by the nightly reconciliation job on the staging ledger, 200 rows.",
    kind: "file",
    mime: "text/csv",
    size: 14_902,
    status: "approved",
    created_by: "runner:loft",
    hoursAgo: 70,
    reviewed_by: "human:maya",
    tags: ["reconciliation"],
  },
];

function mockAssets(now: number): Asset[] {
  const H = 3_600_000;
  return MOCK_ASSET_SEEDS.map((s) => {
    const created = new Date(now - s.hoursAgo * H).toISOString();
    const reviewed = s.reviewed_by ? new Date(now - (s.hoursAgo - 2) * H).toISOString() : null;
    const base = `/api/assets/mock/${s.id}`;
    const hasBytes = s.kind !== "video";
    return {
      id: s.id,
      project: s.project,
      issue: s.issue ?? null,
      pr: s.pr ?? null,
      title: s.title,
      description: s.description,
      kind: s.kind,
      mime: s.mime,
      size: s.size,
      sha256: `${s.id.toLowerCase().replace(/[^0-9a-f]/g, "0")}${"0".repeat(64)}`.slice(0, 64),
      width: s.width ?? null,
      height: s.height ?? null,
      duration_ms: s.duration_ms ?? null,
      version: s.version ?? 1,
      parent_id: s.parent_id ?? null,
      status: s.status,
      created_by: s.created_by,
      created_at: created,
      reviewed_by: s.reviewed_by ?? null,
      reviewed_at: reviewed,
      review_note: s.review_note ?? null,
      public_url: null,
      expires_at: s.status === "rejected" || s.status === "superseded" ? new Date(now + 30 * 24 * H).toISOString() : null,
      tags: s.tags,
      url: hasBytes ? base : null,
      thumb_url: s.kind === "image" || s.kind === "video" ? `${base}?thumb=1` : null,
      bundle_url: s.kind === "html" ? base : null,
    };
  });
}

function build(now: number): Dataset {
  const rand = rng(20261013);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const H = 3_600_000;
  const MIN = 60_000;

  const events: Array<Omit<FeedEvent, "id">> = [];
  const push = (e: Omit<FeedEvent, "id" | "payload" | "dedupe_key" | "tokens_in" | "tokens_out" | "cache_read" | "cache_write" | "cost_equiv" | "duration_ms"> & Partial<FeedEvent>) => {
    events.push({
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_write: 0,
      cost_equiv: 0,
      duration_ms: null,
      payload: {},
      dedupe_key: null,
      ...e,
    });
  };

  const issueCounter: Record<string, number> = { relay: 140, "atlas-site": 61, "ledger-api": 88, "studio-app": 33 };
  const prCounter: Record<string, number> = { relay: 141, "atlas-site": 62, "ledger-api": 89, "studio-app": 34 };

  // 18 tasks spread over the last ~9 days, newest last. The last few are left in progress.
  const N = 18;
  const taskPlan: Array<{ project: string; title: string; lane: Lane; startAgoMs: number; stage: number }> = [];
  const projectsCycle = ["relay", "ledger-api", "atlas-site", "relay", "studio-app", "ledger-api", "atlas-site", "relay"];
  const titleIdx: Record<string, number> = { relay: 0, "atlas-site": 0, "ledger-api": 0, "studio-app": 0 };
  for (let i = 0; i < N; i++) {
    const project = projectsCycle[i % projectsCycle.length] as string;
    const titles = TASKS[project] as string[];
    const title = titles[(titleIdx[project] as number) % titles.length] as string;
    titleIdx[project] = (titleIdx[project] as number) + 1;
    const p = MOCK_PROJECTS.find((x) => x.slug === project) as MockProject;
    // The two newest tasks run on the claude lane so the 5-hour meter has something to show.
    const lane: Lane = i >= N - 2 ? "claude" : pick(p.lanes);
    // Spread: oldest ~9 days ago, newest 25 minutes ago (still running).
    const startAgoMs =
      i === N - 1
        ? 25 * MIN
        : Math.round((9 * 24 * H * (N - 1 - i)) / (N - 1) + rand() * 5 * H) + 15 * MIN;
    // stage: 1 running, 2 PR open + preview, 3 reviewed, 4 merged
    const stage = i >= N - 2 ? 1 : i >= N - 4 ? 2 : i >= N - 6 ? 3 : 4;
    taskPlan.push({ project, title, lane, startAgoMs, stage });
  }

  for (const t of taskPlan) {
    const p = MOCK_PROJECTS.find((x) => x.slug === t.project) as MockProject;
    const issue = (issueCounter[t.project] as number) + 1;
    issueCounter[t.project] = issue;
    const repoUrl = `https://github.com/${p.repo}`;
    let ts = now - t.startAgoMs;
    const opener = rand() < 0.6 ? HUMAN : BOT;
    const runner = t.project === "studio-app" ? RUNNER : rand() < 0.7 ? RUNNER : RUNNER_ALT;
    const lm = LANE_MODEL[t.lane];

    push({
      ts: new Date(ts).toISOString(),
      kind: "issue.opened",
      actor: opener,
      project: t.project,
      repo: p.repo,
      issue,
      pr: null,
      lane: null,
      model: null,
      subscription: null,
      summary: t.title,
      url: `${repoUrl}/issues/${issue}`,
      payload: { via: opener === BOT ? "grok-bot" : "github" },
    });
    ts += between(1, 4) * MIN;
    push({
      ts: new Date(ts).toISOString(),
      kind: "issue.labeled",
      actor: opener,
      project: t.project,
      repo: p.repo,
      issue,
      pr: null,
      lane: t.lane,
      model: null,
      subscription: null,
      summary: `Labelled agent:${t.lane}`,
      url: `${repoUrl}/issues/${issue}`,
      payload: { label: `agent:${t.lane}` },
    });
    if (t.stage < 1) continue;

    ts += between(1, 9) * MIN;
    const runStart = ts;
    push({
      ts: new Date(ts).toISOString(),
      kind: "run.started",
      actor: runner,
      project: t.project,
      repo: p.repo,
      issue,
      pr: null,
      lane: t.lane,
      model: lm.model,
      subscription: lm.subscription,
      summary: `Claimed #${issue} on ${t.lane} lane, fresh worktree`,
      url: `${repoUrl}/actions/runs/${between(18_000_000_000, 18_999_999_999)}`,
      payload: { worktree: `.harness/wt/${issue}` },
    });

    const steps = between(1, 3);
    let runCost = 0;
    let runTokens = 0;
    for (let s = 0; s < steps; s++) {
      ts += between(2, 11) * MIN;
      const tin = between(6_000, 42_000);
      const cr = rand() < 0.7 ? between(4_000, 60_000) : 0;
      const tout = between(900, 7_500);
      const cw = cr > 0 && rand() < 0.5 ? between(2_000, 12_000) : 0;
      const cost = costEquiv(lm.model, tin, tout, cr, cw);
      const dur = between(40_000, 420_000);
      runCost += cost;
      runTokens += tin + cr;
      push({
        ts: new Date(ts).toISOString(),
        kind: "step.usage",
        actor: runner,
        project: t.project,
        repo: p.repo,
        issue,
        pr: null,
        lane: t.lane,
        model: lm.model,
        subscription: lm.subscription,
        tokens_in: tin,
        tokens_out: tout,
        cache_read: cr,
        cache_write: cw,
        cost_equiv: cost,
        duration_ms: dur,
        summary: `${s === 0 ? "Plan and edit" : s === 1 ? "Run checks and fix" : "Write PR description"} · step ${s + 1}/${steps}`,
        url: null,
        payload: { step: s + 1, exit: 0 },
      });
    }

    // The newest run is still in progress: no run.finished yet.
    if (t.stage === 1 && t.startAgoMs < 2 * H) continue;

    ts += between(1, 3) * MIN;
    const failed = t.stage >= 2 ? false : rand() < 0.5;
    push({
      ts: new Date(ts).toISOString(),
      kind: failed ? "run.failed" : "run.finished",
      actor: runner,
      project: t.project,
      repo: p.repo,
      issue,
      pr: null,
      lane: t.lane,
      model: lm.model,
      subscription: lm.subscription,
      duration_ms: ts - runStart,
      cost_equiv: 0,
      summary: failed
        ? `${p.check_cmd.split(" ")[0]} failed; left notes on #${issue}`
        : `${steps} step${steps > 1 ? "s" : ""}, ${(runTokens / 1000).toFixed(0)}K context, $${runCost.toFixed(2)}`,
      url: `${repoUrl}/issues/${issue}`,
      payload: { exit: failed ? 1 : 0, steps },
    });
    if (failed || t.stage < 2) continue;

    const pr = (prCounter[t.project] as number) + 1;
    prCounter[t.project] = pr;
    ts += between(1, 2) * MIN;
    push({
      ts: new Date(ts).toISOString(),
      kind: "pr.opened",
      actor: runner,
      project: t.project,
      repo: p.repo,
      issue,
      pr,
      lane: t.lane,
      model: lm.model,
      subscription: lm.subscription,
      summary: `${t.title} (#${issue})`,
      url: `${repoUrl}/pull/${pr}`,
      payload: { branch: `relay/${issue}-${t.lane}`, additions: between(20, 480), deletions: between(2, 140) },
    });
    ts += between(2, 6) * MIN;
    const ciOk = rand() < 0.85;
    push({
      ts: new Date(ts).toISOString(),
      kind: "workflow.run",
      actor: "bot:github-actions",
      project: t.project,
      repo: p.repo,
      issue,
      pr,
      lane: null,
      model: null,
      subscription: null,
      duration_ms: between(90_000, 600_000),
      summary: `CI ${ciOk ? "passed" : "failed"} on relay/${issue}-${t.lane}`,
      url: `${repoUrl}/actions/runs/${between(18_000_000_000, 18_999_999_999)}`,
      payload: { conclusion: ciOk ? "success" : "failure" },
    });
    if (t.project === "atlas-site" || t.project === "relay") {
      ts += between(1, 4) * MIN;
      const ok = rand() < 0.9;
      push({
        ts: new Date(ts).toISOString(),
        kind: ok ? "preview.ready" : "preview.failed",
        actor: VERCEL,
        project: t.project,
        repo: p.repo,
        issue,
        pr,
        lane: null,
        model: null,
        subscription: null,
        duration_ms: between(40_000, 180_000),
        summary: ok ? `Preview deployed for #${pr}` : `Build failed for #${pr}`,
        url: ok ? `https://${t.project}-git-relay-${issue}-acme.vercel.app` : `https://vercel.com/acme/${t.project}/deployments`,
        payload: { target: "preview" },
      });
    }
    if (t.stage < 3) continue;

    // Review lane on a different model.
    ts += between(4, 25) * MIN;
    const rin = between(9_000, 30_000);
    const rout = between(600, 2_400);
    const rcr = between(0, 20_000);
    const rcost = costEquiv(REVIEW_MODEL.model, rin, rout, rcr, 0);
    push({
      ts: new Date(ts).toISOString(),
      kind: "step.usage",
      actor: runner,
      project: t.project,
      repo: p.repo,
      issue,
      pr,
      lane: REVIEW_MODEL.lane,
      model: REVIEW_MODEL.model,
      subscription: REVIEW_MODEL.subscription,
      tokens_in: rin,
      tokens_out: rout,
      cache_read: rcr,
      cache_write: 0,
      cost_equiv: rcost,
      duration_ms: between(30_000, 150_000),
      summary: `Review #${pr} · diff and tests`,
      url: null,
      payload: { step: "review" },
    });
    ts += between(1, 2) * MIN;
    const approved = rand() < 0.75;
    push({
      ts: new Date(ts).toISOString(),
      kind: "pr.review",
      actor: AGENT,
      project: t.project,
      repo: p.repo,
      issue,
      pr,
      lane: REVIEW_MODEL.lane,
      model: REVIEW_MODEL.model,
      subscription: null,
      summary: approved ? `Approved #${pr}: tests cover the new path` : `Requested changes on #${pr}: missing migration guard`,
      url: `${repoUrl}/pull/${pr}#pullrequestreview-${between(2_000_000_000, 2_999_999_999)}`,
      payload: { state: approved ? "approved" : "changes_requested" },
    });
    if (t.stage < 4) continue;

    ts += between(30, 300) * MIN;
    push({
      ts: new Date(ts).toISOString(),
      kind: "pr.merged",
      actor: HUMAN,
      project: t.project,
      repo: p.repo,
      issue,
      pr,
      lane: null,
      model: null,
      subscription: null,
      summary: `Merged #${pr} into main`,
      url: `${repoUrl}/pull/${pr}`,
      payload: { merge_commit: Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0") },
    });
    ts += between(1, 3) * MIN;
    push({
      ts: new Date(ts).toISOString(),
      kind: "issue.closed",
      actor: "bot:github-actions",
      project: t.project,
      repo: p.repo,
      issue,
      pr,
      lane: null,
      model: null,
      subscription: null,
      summary: `Closed #${issue} via #${pr}`,
      url: `${repoUrl}/issues/${issue}`,
      payload: {},
    });
    if (rand() < 0.6) {
      ts += between(2, 8) * MIN;
      const d = pick(DECISIONS[t.project] as Array<{ text: string }>);
      push({
        ts: new Date(ts).toISOString(),
        kind: "decision.captured",
        actor: AGENT,
        project: t.project,
        repo: p.repo,
        issue,
        pr,
        lane: "claude",
        model: LANE_MODEL.claude.model,
        subscription: null,
        summary: d.text.length > 96 ? `${d.text.slice(0, 93)}...` : d.text,
        url: `${repoUrl}/pull/${pr}`,
        payload: { source: "pr" },
      });
    }
  }

  // Nightly consolidation and onboarding refreshes.
  for (let d = 1; d <= 9; d++) {
    const at = new Date(now - d * 24 * H);
    at.setHours(3, 10 + between(0, 20), 0, 0);
    push({
      ts: at.toISOString(),
      kind: "memory.consolidated",
      actor: "agent:claude",
      project: null,
      repo: null,
      issue: null,
      pr: null,
      lane: "claude",
      model: LANE_MODEL.claude.model,
      subscription: "max",
      tokens_in: between(12_000, 28_000),
      tokens_out: between(1_500, 4_000),
      cost_equiv: 0,
      duration_ms: between(60_000, 240_000),
      summary: `Nightly: ${between(0, 3)} decisions superseded, rules file regenerated for ${between(2, 4)} repos`,
      url: null,
      payload: {},
    });
  }
  const onboardAt = new Date(now - 2 * 24 * H);
  onboardAt.setHours(9, 42, 0, 0);
  push({
    ts: onboardAt.toISOString(),
    kind: "onboard.refreshed",
    actor: HUMAN,
    project: null,
    repo: null,
    issue: null,
    pr: null,
    lane: null,
    model: "openai/gpt-5.5",
    subscription: null,
    summary: "Refreshed official guidance for openai/gpt-5.5: 96 chunks, 3 skills",
    url: null,
    payload: { guidance_count: 96, skill_count: 3 },
  });

  // Assets and the events their lifecycle wrote.
  const assets = mockAssets(now);
  for (const a of assets) {
    const repo = MOCK_PROJECTS.find((p) => p.slug === a.project)?.repo ?? null;
    push({
      ts: a.created_at,
      kind: "asset.uploaded",
      actor: a.created_by,
      project: a.project,
      repo,
      issue: a.issue,
      pr: a.pr,
      lane: null,
      model: null,
      subscription: null,
      summary: a.version > 1 ? `${a.title} (v${a.version})` : a.title,
      url: `/assets/${a.id}`,
      payload: { asset_id: a.id, kind: a.kind, mime: a.mime, size: a.size, version: a.version, parent_id: a.parent_id, sha256: a.sha256 },
    });
    if (a.reviewed_by && a.reviewed_at) {
      const verb = a.status === "rejected" ? "rejected" : "approved";
      push({
        ts: a.reviewed_at,
        kind: "asset.reviewed",
        actor: a.reviewed_by,
        project: a.project,
        repo,
        issue: a.issue,
        pr: a.pr,
        lane: null,
        model: null,
        subscription: null,
        summary: `${verb}: ${a.title}${a.review_note ? ` — ${a.review_note}` : ""}`,
        url: `/assets/${a.id}`,
        payload: { asset_id: a.id, decision: a.status, note: a.review_note, version: a.version },
      });
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const withIds: FeedEvent[] = events.map((e, i) => ({ ...e, id: i + 1 }));

  // Decisions from the table above.
  const decisions: Decision[] = [];
  let did = 100;
  for (const [project, list] of Object.entries(DECISIONS)) {
    for (const d of list) {
      did += 1;
      const p = MOCK_PROJECTS.find((x) => x.slug === project) as MockProject;
      decisions.push({
        id: did,
        project,
        text: d.text,
        source: d.source,
        source_ref: d.source === "pr" ? `https://github.com/${p.repo}/pull/${between(40, 139)}` : d.source === "human" ? null : `session ${Math.floor(rand() * 0xffffff).toString(16)}`,
        valid_from: new Date(now - d.daysAgo * 24 * H).toISOString(),
      });
    }
  }

  const models: ModelInfo[] = MODELS.map((m) => ({
    ...m,
    onboarded_at:
      m.status === "pending" ? null : new Date(now - (m.status === "stale" ? 41 : m.id.includes("gpt") ? 2 : 12) * 24 * H).toISOString(),
  }));

  const lastRunner = (name: string) => withIds.filter((e) => e.actor === name).at(-1)?.ts ?? new Date(now - 3 * 24 * H).toISOString();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const runsToday = (name: string) => withIds.filter((e) => e.actor === name && e.kind === "run.started" && new Date(e.ts).getTime() >= today.getTime()).length;
  const inProgress = (name: string) => {
    const started = withIds.filter((e) => e.actor === name && e.kind === "run.started");
    const last = started.at(-1);
    if (!last) return null;
    const finished = withIds.some((e) => e.actor === name && (e.kind === "run.finished" || e.kind === "run.failed") && e.issue === last.issue && e.ts > last.ts);
    return finished ? null : { project: last.project as string, issue: last.issue as number, startedAt: last.ts };
  };

  const workers: Worker[] = [
    {
      name: "studio",
      host: "studio.local",
      labels: ["xcode", "gpu"],
      version: "0.1.0",
      lastSeen: new Date(now - 40_000).toISOString(),
      status: "online",
      lanes: ["claude", "codex", "grok"],
      runsToday: runsToday(RUNNER),
      pollMs: 15_000,
      current: inProgress(RUNNER),
    },
    {
      name: "loft",
      host: "loft.local",
      labels: [],
      version: "0.1.0",
      lastSeen: lastRunner(RUNNER_ALT) > new Date(now - 20 * MIN).toISOString() ? new Date(now - 3 * MIN).toISOString() : new Date(now - 14 * MIN).toISOString(),
      status: "idle",
      lanes: ["claude", "codex"],
      runsToday: runsToday(RUNNER_ALT),
      pollMs: 300_000,
      current: inProgress(RUNNER_ALT),
    },
    {
      name: "field",
      host: "field-laptop",
      labels: [],
      version: "0.0.9",
      lastSeen: new Date(now - 3 * 24 * H - 5 * H).toISOString(),
      status: "offline",
      lanes: ["claude"],
      runsToday: 0,
      pollMs: null,
      current: null,
    },
  ];

  return { now, events: withIds, decisions, models, workers, assets, nextId: withIds.length + 1 };
}

declare global {
  // eslint-disable-next-line no-var
  var __relayMock: Dataset | undefined;
}

export function dataset(): Dataset {
  if (!globalThis.__relayMock) globalThis.__relayMock = build(Date.now());
  return globalThis.__relayMock;
}

/** Append an event; dedupe_key makes replays a no-op (returns the existing row). */
export function appendEvent(input: NewEvent): FeedEvent {
  const ds = dataset();
  if (input.dedupe_key) {
    const existing = ds.events.find((e) => e.dedupe_key === input.dedupe_key);
    if (existing) return existing;
  }
  const row: FeedEvent = {
    id: ds.nextId++,
    ts: input.ts ?? new Date().toISOString(),
    kind: input.kind as EventKind,
    actor: input.actor,
    project: input.project ?? null,
    repo: input.repo ?? null,
    issue: input.issue ?? null,
    pr: input.pr ?? null,
    lane: input.lane ?? null,
    model: input.model ?? null,
    subscription: input.subscription ?? null,
    tokens_in: input.tokens_in ?? 0,
    tokens_out: input.tokens_out ?? 0,
    cache_read: input.cache_read ?? 0,
    cache_write: input.cache_write ?? 0,
    cost_equiv: input.cost_equiv ?? 0,
    duration_ms: input.duration_ms ?? null,
    summary: input.summary,
    url: input.url ?? null,
    payload: input.payload ?? {},
    dedupe_key: input.dedupe_key ?? null,
  };
  ds.events.push(row);
  ds.events.sort((a, b) => a.ts.localeCompare(b.ts));
  return row;
}

export const MOCK_DECISION_SOURCES = ["claude", "codex", "grok", "pr", "human", "nightly"] as const;
