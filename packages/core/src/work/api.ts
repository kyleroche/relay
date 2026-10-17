/**
 * What a worker calls: `WorkApi`, with two implementations. `localWorkApi` runs the server functions on the machine's
 * own database (a laptop with no site, or the tests); `httpWorkApi` talks to a hosted site over `/api/v1` with one
 * bearer token carrying `work:claim` and `memory:read`. The token goes in the Authorization header only.
 */
import { compileBrief, type BriefIssue } from "../brief/index.ts";
import type { Db } from "../db/client.ts";
import type { EventRow } from "../db/events.ts";
import type { Doorbell, WorkerInput, WorkerView } from "../db/workers.ts";
import type { GitHubClient } from "../github/client.ts";
import { dispatchEvent } from "../webhooks/dispatch.ts";
import { RelayHttpError, normalizeSite, taskPath, type HttpFetch } from "../client/http.ts";
import { claimServer, doorbellServer, heartbeatServer, listWorkersServer, registerWorkerServer, releaseServer, startServer, type ClaimInput, type ClaimResult, type DoorbellInput, type HeartbeatInput, type HeartbeatResult, type RegisterResult, type ReleaseInput, type StartInput } from "./server.ts";

export interface BriefRequest {
  project: string;
  lane: string;
  issue: BriefIssue;
  maxTokens?: number;
}

export interface WorkApi {
  readonly mode: "local" | "site";
  register(input: WorkerInput): Promise<RegisterResult>;
  heartbeat(workerId: string, input?: HeartbeatInput): Promise<HeartbeatResult>;
  /** The queue version and queued estimate; null when the site predates the doorbell (the loop then claims on every tick). */
  doorbell(input?: DoorbellInput): Promise<Doorbell | null>;
  claim(input: ClaimInput): Promise<ClaimResult | null>;
  start(taskId: string, input: StartInput): Promise<void>;
  release(taskId: string, input: ReleaseInput): Promise<void>;
  /** The memory envelope for a task (summary, preferences, decisions, guidance), or "" when memory has nothing. */
  brief(req: BriefRequest): Promise<{ text: string; tokens: number }>;
  workers(): Promise<WorkerView[]>;
}

export interface LocalWorkApiOptions {
  github?: GitHubClient | undefined;
  /** Deliver outbound webhooks for the events written (default true). */
  dispatch?: boolean;
}

export function localWorkApi(db: Db, opts: LocalWorkApiOptions = {}): WorkApi {
  const after = async (events: EventRow[]) => {
    if (opts.dispatch === false) return;
    for (const e of events) await dispatchEvent(db, e).catch(() => {});
  };
  return {
    mode: "local",
    async register(input) {
      const r = await registerWorkerServer(db, input);
      await after(r.events);
      return r;
    },
    async heartbeat(id, input = {}) {
      const r = await heartbeatServer(db, id, input);
      await after(r.events);
      return r;
    },
    doorbell: (input = {}) => doorbellServer(db, input),
    claim: (input) => claimServer(db, input, { github: opts.github }),
    async start(taskId, input) {
      await after((await startServer(db, taskId, input)).events);
    },
    async release(taskId, input) {
      await after((await releaseServer(db, taskId, input)).events);
    },
    async brief(req) {
      const b = await compileBrief(db, { project: req.project, intent: `implement issue #${req.issue.number ?? ""}: ${req.issue.title}`, lane: req.lane, issue: req.issue, maxTokens: req.maxTokens ?? 3000 });
      return { text: b.text, tokens: b.tokens };
    },
    workers: () => listWorkersServer(db),
  };
}

export interface HttpWorkApiOptions {
  site: string;
  token: string;
  fetch?: HttpFetch;
}

export function httpWorkApi(opts: HttpWorkApiOptions): WorkApi {
  const site = normalizeSite(opts.site);
  const doFetch: HttpFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  async function rest<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${site}/api/v1${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await doFetch(url.toString(), {
      method,
      headers: { authorization: `Bearer ${opts.token}`, accept: "application/json", "user-agent": "relay-work", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = { detail: text.slice(0, 200) };
    }
    if (!res.ok) {
      const p = (parsed ?? {}) as { title?: string; detail?: string; instance?: string };
      throw new RelayHttpError(res.status, p.title ?? `HTTP ${res.status}`, p.detail ?? "", p.instance ?? url.pathname);
    }
    return parsed as T;
  }
  return {
    mode: "site",
    register: (input) => rest<RegisterResult>("POST", "/workers", input),
    heartbeat: (id, input = {}) => rest<HeartbeatResult>("POST", `/workers/${encodeURIComponent(id)}/heartbeat`, input),
    async doorbell(input = {}) {
      try {
        const r = await rest<Partial<Doorbell>>("GET", "/work/doorbell", undefined, { lanes: input.lanes?.length ? input.lanes.join(",") : undefined });
        if (typeof r.version !== "number") return null;
        return { version: r.version, queued: typeof r.queued === "number" ? r.queued : 0, ts: r.ts ?? new Date().toISOString() };
      } catch (e) {
        // an older site has no doorbell: say so once per call and let the loop claim instead
        if (e instanceof RelayHttpError && (e.status === 404 || e.status === 405 || e.status === 501)) return null;
        throw e;
      }
    },
    async claim(input) {
      const r = await rest<{ claim: ClaimResult | null }>("POST", "/work/claim", input);
      return r.claim ?? null;
    },
    async start(taskId, input) {
      await rest("POST", `/work/${taskPath(taskId)}/start`, input);
    },
    async release(taskId, input) {
      await rest("POST", `/work/${taskPath(taskId)}/release`, input);
    },
    async brief(req) {
      try {
        const r = await rest<{ text?: string; tokens?: number }>("GET", `/projects/${encodeURIComponent(req.project)}/brief`, undefined, { issue: req.issue.number, lane: req.lane, max_tokens: req.maxTokens ?? 3000 });
        return { text: r.text ?? "", tokens: r.tokens ?? 0 };
      } catch (e) {
        if (e instanceof RelayHttpError && (e.status === 403 || e.status === 404)) return { text: "", tokens: 0 };
        throw e;
      }
    },
    async workers() {
      const r = await rest<{ workers: WorkerView[] }>("GET", "/workers");
      return r.workers;
    },
  };
}
