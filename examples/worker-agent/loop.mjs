/**
 * The worker loop over relay's MCP tools (docs/WORKER-AGENTS.md), with nothing of its own: `call(name, args)` is how
 * it reaches the server, `doJob(job, ctx)` is the app's work, `put` uploads bytes, `sleep` and `now` are the clock.
 * `worker.mjs` wires these to a real MCP client; the test in packages/mcp/test drives them against the in-memory
 * server. Every step is one tool call, in the order the guide gives:
 *
 *   register → (doorbell → claim when the version moved → start → heartbeat while working → upload → release)* → offline
 */

export const DEFAULTS = Object.freeze({
  /** First idle tick (ms); doubles while nothing happens. */
  interval: 15_000,
  /** The tick's ceiling (ms). */
  maxInterval: 300_000,
  /** How often the lease is renewed while a job runs (ms). The lease itself lasts 30 minutes. */
  heartbeat: 60_000,
});

/** The next idle interval: back to the floor after activity, otherwise doubled up to the ceiling. */
export function nextInterval(current, activity, opts = DEFAULTS) {
  if (activity) return opts.interval;
  return Math.min(current * 2, opts.maxInterval);
}

/** Read one tool result: the first text block as JSON (`null` is a legitimate answer: nothing to claim). */
export function parseResult(result) {
  if (result?.isError) {
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    throw new ToolError(text || "tool error");
  }
  const text = (result.content ?? []).find((c) => c.type === "text")?.text ?? "null";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
}

/** A `put` for the real world: PUT the bytes to the signed upload URL with the headers the server asked for. */
export async function fetchPut(url, bytes, headers) {
  const res = await fetch(url, { method: "PUT", headers, body: bytes });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${res.statusText}`);
}

/**
 * Build the loop.
 *
 * @param {object} deps
 * @param {(name: string, args: object) => Promise<any>} deps.call   one MCP tool call; returns the parsed result, throws on a tool error
 * @param {(job: object, ctx: object) => Promise<{summary?: string, assets?: string[], usage?: object}>} deps.doJob  the app's work
 * @param {string} deps.name            the worker's name (stable: the id is reused)
 * @param {string[]} deps.lanes         the lanes it serves
 * @param {string[]} [deps.labels]      capabilities, e.g. app:<name>, machine:<model>
 * @param {string} [deps.host]
 * @param {string} [deps.version]
 * @param {(url: string, bytes: Uint8Array, headers: object) => Promise<void>} [deps.put]  default: fetch PUT
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 * @param {(line: string) => void} [deps.log]
 * @param {object} [deps.timing]        interval, maxInterval, heartbeat (ms)
 */
export function createLoop(deps) {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const put = deps.put ?? fetchPut;
  const timing = { ...DEFAULTS, ...(deps.timing ?? {}) };
  const state = { workerId: null, version: null, interval: timing.interval, lastHeartbeat: 0, busy: false };

  async function register() {
    const r = await deps.call("relay_work_register", {
      name: deps.name,
      lanes: deps.lanes,
      ...(deps.labels?.length ? { labels: deps.labels } : {}),
      ...(deps.host ? { host: deps.host } : {}),
      ...(deps.version ? { version: deps.version } : {}),
    });
    state.workerId = r.worker_id;
    log(`registered as ${r.name} (${r.worker_id}) for ${r.lanes.join(", ")}${r.registered ? ", new" : ""}`);
    return r;
  }

  async function heartbeat(extra = {}) {
    state.lastHeartbeat = now();
    return deps.call("relay_work_heartbeat", { worker_id: state.workerId, ...extra });
  }

  /** Upload one output onto the task's issue: reserve, PUT, finalize. Returns the asset row. */
  async function upload(claim, { filename, bytes, contentType, title, description, replaces }) {
    const req = await deps.call("relay_asset_request_upload", { project: claim.project, filename, ...(contentType ? { content_type: contentType } : {}) });
    await put(req.upload_url, bytes, req.headers ?? {});
    return deps.call("relay_asset_finalize", {
      key: req.key,
      project: claim.project,
      issue: claim.issue.number,
      title: title ?? filename,
      ...(description ? { description } : {}),
      ...(replaces ? { replaces } : {}),
    });
  }

  /** One claimed task from start to release. Never throws: a failure is reported as `failed`. */
  async function runJob(claim) {
    state.busy = true;
    const startedAt = now();
    const assets = [];
    let timer;
    try {
      await deps.call("relay_work_start", { task_id: claim.task_id, worker_id: state.workerId, ...(deps.host ? { host: deps.host } : {}) });
      log(`${claim.task_id}: started (${claim.lane})`);
      timer = setInterval(() => heartbeat().catch((e) => log(`${claim.task_id}: heartbeat failed: ${e.message}`)), timing.heartbeat);
      if (claim.job_error) throw new Error(`the relay-job block cannot be used: ${claim.job_error}`);
      const ctx = {
        log: (line) => log(`${claim.task_id}: ${line}`),
        heartbeat: () => heartbeat(),
        upload: async (output) => {
          const row = await upload(claim, output);
          assets.push(row.id);
          log(`${claim.task_id}: uploaded ${row.title} as ${row.id}`);
          return row;
        },
      };
      const result = (await deps.doJob(claim, ctx)) ?? {};
      for (const id of result.assets ?? []) if (!assets.includes(id)) assets.push(id);
      const usage = { duration_ms: Math.max(0, now() - startedAt), ...(result.usage ?? {}) };
      const r = await deps.call("relay_work_release", {
        task_id: claim.task_id,
        worker_id: state.workerId,
        outcome: "finished",
        ...(result.summary ? { summary: String(result.summary).slice(0, 400) } : {}),
        usage,
        ...(assets.length ? { assets } : {}),
      });
      log(`${claim.task_id}: finished, now ${r.state}`);
      return { outcome: "finished", state: r.state, assets };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`${claim.task_id}: failed: ${error}`);
      try {
        const r = await deps.call("relay_work_release", { task_id: claim.task_id, worker_id: state.workerId, outcome: "failed", error: error.slice(0, 2000), usage: { duration_ms: Math.max(0, now() - startedAt) } });
        return { outcome: "failed", state: r.state, assets, error };
      } catch (e2) {
        log(`${claim.task_id}: release failed too (the lease may have lapsed; the task is queued again): ${e2 instanceof Error ? e2.message : e2}`);
        return { outcome: "failed", state: null, assets, error };
      }
    } finally {
      if (timer) clearInterval(timer);
      state.busy = false;
    }
  }

  /** Claim once: null when nothing is claimable, else the job's result. */
  async function claimOnce() {
    const claim = await deps.call("relay_work_claim", { worker_id: state.workerId });
    if (!claim) return null;
    state.interval = timing.interval;
    return runJob(claim);
  }

  /**
   * One idle tick: read the doorbell, claim when the version moved or something looks queued, heartbeat at most once
   * per interval. Returns what happened so a caller (or a test) can decide what to do next.
   */
  async function tick() {
    const bell = await deps.call("relay_work_doorbell", { lanes: deps.lanes });
    const moved = state.version === null || bell.version !== state.version || bell.queued > 0;
    state.version = bell.version;
    let ran = null;
    if (moved) {
      ran = await claimOnce();
      // a queue that held one task often holds another
      while (ran) {
        const again = await claimOnce();
        if (!again) break;
        ran = again;
      }
    }
    // the wait before the next tick: back at the floor after a claim (claimOnce reset it), otherwise where the doubling got to
    const wait = state.interval;
    if (now() - state.lastHeartbeat >= Math.min(wait, timing.maxInterval)) await heartbeat({ interval_ms: wait });
    state.interval = nextInterval(wait, false, timing);
    return { bell, claimed: ran !== null, result: ran, interval: wait };
  }

  /** The loop: register, then tick and sleep until `signal` aborts; then report offline. */
  async function run({ signal } = {}) {
    if (!state.workerId) await register();
    while (!signal?.aborted) {
      let wait = state.interval;
      try {
        const t = await tick();
        wait = t.interval;
        if (!t.claimed) log(`idle: version ${t.bell.version}, ${t.bell.queued} queued; next check in ${Math.round(wait / 1000)} s`);
      } catch (e) {
        log(`tick failed: ${e instanceof Error ? e.message : e}`);
        if (/register first|404/.test(String(e))) await register().catch((e2) => log(`re-register failed: ${e2.message}`));
        state.interval = nextInterval(wait, false, timing);
      }
      if (signal?.aborted) break;
      await sleep(wait);
    }
    await shutdown();
  }

  async function shutdown() {
    if (!state.workerId) return;
    try {
      await heartbeat({ status: "offline" });
      log("offline");
    } catch (e) {
      log(`offline heartbeat failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { state, register, heartbeat, tick, claimOnce, runJob, upload, run, shutdown };
}
