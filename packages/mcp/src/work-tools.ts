/**
 * The worker protocol as MCP tools (scope `work:claim`), for an external app's agent that becomes a relay worker
 * without the CLI (docs/WORKER-AGENTS.md): register, doorbell, claim, start, heartbeat, release, and a re-read of a
 * claimed task's job. Each tool mirrors one REST route under /api/v1/workers and /api/v1/work and calls the same
 * server function (packages/core/src/work/server.ts), so the feed rows, the actor (`runner:<worker name>`), the
 * leases and the task derivation are the ones `relay work` produces. The claim adds what an app worker cannot fetch
 * for itself: the issue text, the compiled brief and the parsed ```relay-job manifest with its input assets signed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  claimServer,
  compileBrief,
  doorbellServer,
  heartbeatServer,
  ManifestError,
  parseJobManifest,
  registerWorkerServer,
  releaseServer,
  repo,
  resolveJobInputs,
  sanitizeMeters,
  startServer,
  WORKER_NAME,
  WorkError,
  type ClaimedIssue,
  type CompileBriefOptions,
  type Db,
  type ExtraUsage,
  type GitHubClient,
  type JobManifest,
  type ResolvedJobInput,
  type RunUsage,
  type TaskRow,
  type TokenScope,
  type WorkerRow,
} from "@relay/core";

/** A lane name as a label carries it; which lanes exist is the registry's business, not this tool's. */
export const LANE_SHAPE = /^[a-z][a-z0-9-]{0,31}$/;
const LANE_HELP = "lowercase letters, digits and dashes (embroidery, laser, claude)";
const LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const ISSUE_BODY_TOKENS = 6000;

export interface WorkToolContext {
  db: Db;
  /** True when the connection holds `scope` (the scope gate's data). */
  has: (scope: TokenScope) => boolean;
  /** The scope refusal every tool returns when `has` says no. */
  refuse: (scope: TokenScope, tool: string) => ToolResult;
  /** Fan a feed row out (webhooks) after it is written. */
  emit: (row: repo.EventRow | undefined) => Promise<void>;
  github?: GitHubClient | undefined;
  embed?: CompileBriefOptions["embed"];
  briefTokens: number;
  /** Sign a read URL for an asset key, mapped to what the caller can fetch; null when no store is configured. */
  assets?: { sign: (key: string, ttl: number) => Promise<string>; ttl: number } | undefined;
  json: (v: unknown) => ToolResult;
  fail: (s: string) => ToolResult;
}

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** The issue as the claim hands it over: text from GitHub when the server can read it, else what relay knows. */
export interface ClaimIssue extends ClaimedIssue {
  labels: string[];
  /** `github` when the text came from the API; `relay` when only the task row was available (body empty). */
  source: "github" | "relay";
}

/** The parsed manifest with every input resolved, or null with the reason the worker should report. */
export interface JobView {
  job: (Omit<JobManifest, "inputs"> & { inputs: ResolvedJobInput[] }) | null;
  job_error: string | null;
}

const publicWorker = (w: WorkerRow) => ({ id: w.id, name: w.name, host: w.host, lanes: w.lanes, labels: w.labels, version: w.version, status: w.status, last_seen: w.last_seen, poll_ms: w.poll_ms });
const kinds = (events: repo.EventRow[]) => events.map((e) => e.kind);
const workFail = (fail: WorkToolContext["fail"], e: unknown) => fail(`relay: ${e instanceof WorkError ? `${e.message} (${e.status})` : e instanceof Error ? e.message : String(e)}`);

export function registerWorkTools(server: McpServer, ctx: WorkToolContext, describe: (name: string) => string): void {
  const { db, json, fail } = ctx;
  const gate = (tool: string, alsoWith?: TokenScope) => (ctx.has("work:claim") || (alsoWith && ctx.has(alsoWith)) ? undefined : ctx.refuse("work:claim", tool));

  const issueFor = async (task: TaskRow, lane: string): Promise<ClaimIssue> => {
    const url = `https://github.com/${task.repo}/issues/${task.issue}`;
    if (ctx.github) {
      try {
        const i = await ctx.github.getIssue(task.repo, task.issue);
        return { number: i.number, title: i.title, body: i.body ?? "", url: i.html_url || url, labels: i.labels ?? [], source: "github" };
      } catch {
        /* fall through to what relay knows */
      }
    }
    return { number: task.issue, title: task.title ?? `issue #${task.issue}`, body: "", url, labels: [`agent:${lane}`], source: "relay" };
  };

  const jobFor = async (task: TaskRow, body: string): Promise<JobView> => {
    try {
      const m = parseJobManifest(body);
      if (!m) return { job: null, job_error: null };
      if (m.inputs.length && !ctx.assets) return { job: null, job_error: "the manifest names input assets but this server has no asset store configured" };
      const inputs = m.inputs.length ? await resolveJobInputs(db, { getSignedUrl: ctx.assets!.sign }, m, task.project, ctx.assets!.ttl) : [];
      return { job: { ...m, inputs }, job_error: null };
    } catch (e) {
      return { job: null, job_error: e instanceof ManifestError ? e.message : e instanceof Error ? e.message : String(e) };
    }
  };

  const briefFor = async (task: TaskRow, lane: string, issue: ClaimIssue): Promise<string | null> => {
    if (!ctx.has("memory:read")) return null;
    try {
      const b = await compileBrief(db, {
        project: task.project,
        intent: `implement issue #${issue.number}: ${issue.title}`,
        lane,
        issue: { number: issue.number, title: issue.title, body: issue.body.slice(0, ISSUE_BODY_TOKENS) },
        maxTokens: ctx.briefTokens,
        ...(ctx.embed ? { embed: ctx.embed } : {}),
      });
      return b.text;
    } catch {
      return null;
    }
  };

  const stateOf = async (taskId: string): Promise<string | null> => {
    const t = await repo.getTask(db, taskId);
    return t ? (await repo.taskView(db, t)).state : null;
  };

  server.registerTool(
    "relay_work_register",
    {
      title: "Register a worker",
      description: describe("relay_work_register"),
      inputSchema: {
        name: z.string().regex(WORKER_NAME, "1-64 characters: letters, digits, dot, dash, underscore").describe("the worker's name; stable across restarts (the id is reused)"),
        host: z.string().max(200).optional().describe("the machine, for the workers page"),
        lanes: z.array(z.string().regex(LANE_SHAPE, LANE_HELP)).min(1).max(16).describe("the lanes this worker serves; a task's agent:<lane> label must be one of them"),
        labels: z.array(z.string().regex(LABEL_SHAPE)).max(32).optional().describe("capabilities, e.g. app:stitchwerx, machine:brother-pe800; a project may require some with the lane.labels preference"),
        version: z.string().max(64).optional().describe("the app's version"),
      },
    },
    async ({ name, host, lanes, labels, version }) => {
      const g = gate("relay_work_register");
      if (g) return g;
      try {
        const r = await registerWorkerServer(db, { name, host: host ?? "", lanes: [...new Set(lanes)], labels: [...new Set(labels ?? [])], version: version ?? "" });
        for (const e of r.events) await ctx.emit(e);
        return json({ worker_id: r.worker.id, name: r.worker.name, lanes: r.worker.lanes, labels: r.worker.labels, registered: r.created, events: kinds(r.events), next: "relay_work_doorbell({lanes}) on a tick; relay_work_claim({worker_id}) when the version moved" });
      } catch (e) {
        return workFail(fail, e);
      }
    },
  );

  server.registerTool(
    "relay_work_heartbeat",
    {
      title: "Heartbeat",
      description: describe("relay_work_heartbeat"),
      inputSchema: {
        worker_id: z.string().min(1),
        status: z.enum(["online", "offline"]).optional().describe("offline records a clean shutdown"),
        interval_ms: z.number().int().positive().optional().describe("the poll interval the worker is on, for the workers page"),
        meters: z.array(z.record(z.string(), z.unknown())).max(20).optional().describe("plan-meter readings (packages/core/src/meters.ts); replaced when sent, kept when absent"),
      },
    },
    async ({ worker_id, status, interval_ms, meters }) => {
      const g = gate("relay_work_heartbeat");
      if (g) return g;
      try {
        const m = sanitizeMeters(meters);
        const r = await heartbeatServer(db, worker_id, { ...(status ? { status } : {}), ...(interval_ms ? { interval_ms } : {}), ...(m ? { meters: m } : {}) });
        for (const e of r.events) await ctx.emit(e);
        return json({ worker: publicWorker(r.worker), leases: r.leases.map((c) => ({ task_id: c.task_id, lease_until: c.lease_until })), events: kinds(r.events) });
      } catch (e) {
        return workFail(fail, e);
      }
    },
  );

  server.registerTool(
    "relay_work_doorbell",
    {
      title: "Read the doorbell",
      description: describe("relay_work_doorbell"),
      inputSchema: { lanes: z.array(z.string().regex(LANE_SHAPE, LANE_HELP)).max(16).optional().describe("count only tasks for these lanes (the worker's)") },
    },
    async ({ lanes }) => {
      const g = gate("relay_work_doorbell", "feed:read");
      if (g) return g;
      return json(await doorbellServer(db, lanes?.length ? { lanes } : {}));
    },
  );

  server.registerTool(
    "relay_work_claim",
    {
      title: "Claim a task",
      description: describe("relay_work_claim"),
      inputSchema: {
        worker_id: z.string().min(1),
        lanes: z.array(z.string().regex(LANE_SHAPE, LANE_HELP)).max(16).optional().describe("restrict to these of the worker's lanes"),
        labels: z.array(z.string().regex(LABEL_SHAPE)).max(32).optional().describe("extra labels for this claim, on top of the registered ones"),
      },
    },
    async ({ worker_id, lanes, labels }) => {
      const g = gate("relay_work_claim");
      if (g) return g;
      try {
        const r = await claimServer(db, { worker_id, ...(lanes?.length ? { lanes } : {}), ...(labels?.length ? { labels } : {}) });
        if (!r) return json(null);
        const lane = r.task.lane;
        const issue = await issueFor(r.task, lane);
        const [brief, view] = await Promise.all([briefFor(r.task, lane, issue), jobFor(r.task, issue.body)]);
        return json({
          task_id: r.task.id,
          project: r.task.project,
          repo: r.task.repo,
          issue,
          lane,
          lease_until: r.claim.lease_until,
          review_note: r.note ?? null,
          brief: brief ?? "",
          ...(brief === null ? { brief_omitted: ctx.has("memory:read") ? "unavailable" : "needs memory:read" } : {}),
          ...view,
          next: "relay_work_start({task_id, worker_id}) before the work; relay_work_heartbeat({worker_id}) every 60 s while it runs; upload outputs with relay_asset_request_upload + PUT + relay_asset_finalize({issue}); then relay_work_release({task_id, worker_id, outcome})",
        });
      } catch (e) {
        return workFail(fail, e);
      }
    },
  );

  server.registerTool(
    "relay_work_start",
    {
      title: "Start a run",
      description: describe("relay_work_start"),
      inputSchema: { task_id: z.string().min(3).describe("owner/repo#n, from the claim"), worker_id: z.string().min(1), host: z.string().max(200).optional() },
    },
    async ({ task_id, worker_id, host }) => {
      const g = gate("relay_work_start");
      if (g) return g;
      try {
        const r = await startServer(db, task_id.trim(), { worker_id, ...(host ? { host } : {}) });
        for (const e of r.events) await ctx.emit(e);
        return json({ task_id: task_id.trim(), state: (await stateOf(task_id.trim())) ?? "running", lease_until: r.claim.lease_until, events: kinds(r.events) });
      } catch (e) {
        return workFail(fail, e);
      }
    },
  );

  server.registerTool(
    "relay_work_release",
    {
      title: "Release a task",
      description: describe("relay_work_release"),
      inputSchema: {
        task_id: z.string().min(3).describe("owner/repo#n"),
        worker_id: z.string().min(1),
        outcome: z.enum(["finished", "failed", "released"]).describe("finished: the outputs are uploaded (the task is in review); failed: say why in error; released: give the lease back, the task is queued again"),
        summary: z.string().max(500).optional().describe("one line of what was done, for the feed and the board"),
        error: z.string().max(2000).optional().describe("for failed: what went wrong, written for the person who will read the card"),
        usage: z
          .object({
            duration_ms: z.number().int().min(0).optional(),
            cost_equiv: z.number().min(0).optional().describe("USD equivalent of the model calls this run made, if any"),
            model: z.string().max(100).optional(),
            tokens_in: z.number().int().min(0).optional(),
            tokens_out: z.number().int().min(0).optional(),
          })
          .optional(),
        assets: z.array(z.string().min(1).max(64)).max(32).optional().describe("ids of the assets this run uploaded, for the summary"),
      },
    },
    async ({ task_id, worker_id, outcome, summary, error, usage, assets }) => {
      const g = gate("relay_work_release");
      if (g) return g;
      const id = task_id.trim();
      const u = usage ?? {};
      const line = [summary?.trim(), assets?.length ? `(assets: ${assets.join(", ")})` : ""].filter(Boolean).join(" ") || undefined;
      const tokens = (u.tokens_in ?? 0) + (u.tokens_out ?? 0) > 0;
      const row: RunUsage = { tool: "app", model: u.model ?? null, subscription: null, tokens_in: u.tokens_in ?? 0, tokens_out: u.tokens_out ?? 0, cache_read: 0, cache_write: 0, cost_equiv: u.cost_equiv ?? 0, duration_ms: u.duration_ms ?? 0 };
      try {
        const task = await repo.getTask(db, id);
        if (!task) return fail(`relay: no task ${id}`);
        // a usage row with tokens goes the lane's normal way; a cost without tokens (an app that bills per job) is an extra row on the task's lane, written as given
        const extra: ExtraUsage[] = !tokens && (u.cost_equiv ?? 0) > 0 ? [{ ...row, lane: task.lane ?? "app", summary: `${u.model ?? "app"}: $${(u.cost_equiv ?? 0).toFixed(4)} for one job` }] : [];
        const r = await releaseServer(db, id, {
          worker_id,
          outcome,
          ...(line ? { summary: line } : {}),
          ...(error?.trim() ? { error: error.trim() } : {}),
          duration_ms: u.duration_ms ?? null,
          usage: tokens ? row : null,
          extra_usage: extra.length ? extra : null,
        });
        for (const e of r.events) await ctx.emit(e);
        return json({ task_id: id, state: (await stateOf(id)) ?? null, events: kinds(r.events) });
      } catch (e) {
        return workFail(fail, e);
      }
    },
  );

  server.registerTool(
    "relay_work_job",
    { title: "Re-read a task's job", description: describe("relay_work_job"), inputSchema: { task_id: z.string().min(3).describe("owner/repo#n") } },
    async ({ task_id }) => {
      const g = gate("relay_work_job");
      if (g) return g;
      const id = task_id.trim();
      const task = await repo.getTask(db, id);
      if (!task) return fail(`relay: no task ${id}`);
      const lane = task.lane ?? "unknown";
      const issue = await issueFor(task, lane);
      const view = await jobFor(task, issue.body);
      return json({ task_id: task.id, project: task.project, repo: task.repo, lane: task.lane, issue, ...view, ...(issue.source === "relay" ? { note: "the server has no GitHub access, so the issue body (and any relay-job block in it) could not be read" } : {}) });
    },
  );
}
