/**
 * A relay that exists only for the evals: an MCP server on localhost that publishes relay's task and memory tools with
 * the argument shapes of `packages/mcp/src/server.ts`, keeps tasks and a feed in memory, and records every call.
 *
 * Why a server and not only eve's tool stubs: eve lists a connection's tools before it will stub one, so the
 * connection must reach something; and a session the wake route creates takes no stubs at all, so what a wake-up's
 * tools answer has to come from here. Evals that talk to the lead directly still use stubs to set one call's outcome.
 *
 * It is built on the same MCP server library and the same stateless transport as relay's own `/mcp`, so the lead's
 * connection speaks to it exactly as it will to a site. It also publishes the tools the lead must never reach
 * (approve, release, close, and the two that write standing memory): the allowlist in `agent/connections/relay.ts`
 * keeps them from the model, and an eval can prove no call arrived. A real relay also refuses them to the lead's
 * token, which lacks their scopes; this fake has one token and no scopes, so here the allowlist stands alone.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface FakeTask {
  task_id: string;
  project: string;
  title: string;
  state: "waiting" | "queued" | "running" | "review" | "held" | "blocked" | "done" | "failed" | "closed";
  lane: string | null;
  model?: string | null;
  body?: string;
  reason?: string | null;
  pr_url?: string | null;
  notes?: string[];
  plan?: boolean;
}

export interface FakeCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface FakeRelay {
  /** The fake site's origin: what RELAY_SITE is set to for the run. */
  readonly url: string;
  /** A bearer made up for this run; the server refuses any other. */
  readonly token: string;
  /** Every tool call that arrived, oldest first; with a project, only the calls that named it or a task of it. */
  calls(project?: string): FakeCall[];
  seedTask(task: FakeTask): void;
  /** What `relay_recall` answers for a project. Without a seed it answers that nothing matched. */
  seedMemory(project: string, text: string): void;
  /** One row already in the feed, such as a requeue the lead logged in an earlier life. */
  seedFeed(project: string, kind: string, summary: string): void;
  task(id: string): FakeTask | undefined;
  close(): Promise<void>;
}

const LANE = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (t: string) => ({ ...text(t), isError: true });

interface FeedRow {
  ts: string;
  kind: string;
  project: string | null;
  summary: string;
}

export async function startFakeRelay(): Promise<FakeRelay> {
  const token = `eval-${randomUUID()}`;
  const tasks = new Map<string, FakeTask>();
  const memory = new Map<string, string>();
  const feed: FeedRow[] = [];
  const calls: FakeCall[] = [];
  const created = new Map<string, string>();

  const view = (t: FakeTask) => ({ task_id: t.task_id, state: t.state, project: t.project, title: t.title, lane: t.lane, model: t.model ?? null, repo: `example/${t.project}`, pr_url: t.pr_url ?? null, hold: null, needs: [], claim: null, result: null, reason: t.reason ?? null });
  const projectOf = (args: Record<string, unknown>): string | undefined => {
    const named = args.project ?? args.slug;
    if (typeof named === "string") return named;
    const id = args.task_id ?? args.id;
    return typeof id === "string" ? tasks.get(id)?.project : undefined;
  };

  /** One server per request, as relay's own handler builds them: nothing is kept between calls but the maps above. */
  const build = (): McpServer => {
    const server = new McpServer({ name: "relay-fake", version: "0.0.0" });
    const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => ReturnType<typeof text>) =>
      server.registerTool(name, { description, inputSchema: shape }, ((args: z.infer<z.ZodObject<S>>) => {
        calls.push({ tool: name, args: args as Record<string, unknown> });
        return run(args);
      }) as never);

    tool("relay_recall", "Current decisions and preferences relevant to a query. Call before choosing an approach.", { query: z.string(), project: z.string().optional() }, ({ project }) => text((project && memory.get(project)) || "No matching decisions or preferences."));
    tool("relay_brief", "The compiled brief for a project and intent.", { project: z.string(), intent: z.string(), model: z.string().optional(), max_tokens: z.number().int().optional() }, () => text("Memory is empty for this project."));
    tool("relay_project", "A project's record: repo, path, stack, check command, summary and memory counts.", { slug: z.string() }, ({ slug }) => text(`slug: ${slug}\nrepo: example/${slug}\nstack: typescript\ncheck: pnpm test\ndecisions: 0 current\npreferences: 0 at project scope`));
    tool("relay_get_project", "One project by slug with current decisions, models and recent events.", { slug: z.string().min(1) }, ({ slug }) => json({ slug, repo: `example/${slug}`, check_cmd: "pnpm test", decisions: [], events: [] }));
    tool("relay_feed", "Recent feed events as compact lines, newest first.", { project: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), kind: z.string().optional() }, ({ project, kind, limit }) => {
      const rows = feed
        .filter((e) => (!project || e.project === project) && (!kind || (kind.endsWith(".") ? e.kind.startsWith(kind) : e.kind === kind)))
        .slice(-(limit ?? 25))
        .reverse();
      return text(rows.length ? rows.map((e) => `${e.ts.slice(0, 16)} ${e.kind} bot:lead${e.project ? ` ${e.project}` : ""}: ${e.summary}`).join("\n") : "No events.");
    });
    tool("relay_event_log", "Log an external.* event in the feed.", { kind: z.string().regex(/^external\./), project: z.string().optional(), summary: z.string().min(1).max(500), url: z.string().url().optional(), cost_equiv: z.number().min(0).optional(), source: z.string().max(100).optional() }, ({ kind, project, summary }) => {
      const row = { ts: new Date().toISOString(), kind, project: project ?? null, summary };
      feed.push(row);
      return json({ id: feed.length, ts: row.ts, kind, actor: "bot:lead" });
    });
    tool(
      "relay_task_create",
      "Open a task: a thread in the project's queue on the team's Vercel Board, labelled with its lane (and model). With plan: true, a plan task whose worker proposes the tasks.",
      { project: z.string().min(1), title: z.string().min(1).max(200), body: z.string().max(60_000).optional(), lane: LANE.optional(), model: z.string().min(1).max(100).optional(), needs: z.array(z.string().min(1)).max(20).optional(), base: z.string().min(1).max(200).optional(), plan: z.boolean().optional(), idempotency_key: z.string().min(1).max(200).optional() },
      (a) => {
        const before = a.idempotency_key ? created.get(a.idempotency_key) : undefined;
        if (before) return json({ ...view(tasks.get(before)!), created: false });
        const t: FakeTask = { task_id: `msg_${tasks.size + 1}_${randomUUID().slice(0, 8)}`, project: a.project, title: a.title, state: "queued", lane: a.lane ?? "claude", model: a.model ?? null, body: a.body ?? "", ...(a.plan ? { plan: true } : {}) };
        tasks.set(t.task_id, t);
        if (a.idempotency_key) created.set(a.idempotency_key, t.task_id);
        return json({ ...view(t), created: true });
      },
    );
    tool("relay_task_get", "One task by ID with its state, lane, model, pull request, hold, claim, last result, usage and notes.", { task_id: z.string().min(1) }, ({ task_id }) => {
      const t = tasks.get(task_id);
      return t ? json({ ...view(t), body: t.body ?? "", last_result: t.reason ?? null, usage: [], notes: t.notes ?? [] }) : fail(`relay: No task ${task_id}`);
    });
    tool("relay_task_list", "Tasks on the board, oldest first; filter by project and state.", { project: z.string().optional(), state: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }, ({ project, state }) => {
      const open = (t: FakeTask) => t.state !== "done" && t.state !== "closed";
      const rows = [...tasks.values()].filter((t) => (!project || t.project === project) && (state === "all" ? true : !state || state === "open" ? open(t) : t.state === state));
      return json({ tasks: rows.map(view), count: rows.length });
    });
    tool("relay_task_requeue", "Put a failed, held or blocked task back in the queue, optionally on another lane or model.", { id: z.string().min(1), lane: LANE.optional(), model: z.string().min(1).max(100).optional() }, ({ id, lane, model }) => {
      const t = tasks.get(id);
      if (!t) return fail(`relay: No task ${id}`);
      if (t.state === "done" || t.state === "closed") return fail(`relay: task ${id} is ${t.state}; open a new one`);
      Object.assign(t, { state: "queued", reason: null, ...(lane ? { lane } : {}), ...(model ? { model } : {}) });
      return json({ ...view(t), next: "the next idle worker that serves the lane claims it and starts over from the base branch" });
    });
    tool("relay_task_request_changes", "Send a task in review back with a note.", { id: z.string().min(1), note: z.string().min(1).max(6000) }, ({ id, note }) => {
      const t = tasks.get(id);
      if (!t) return fail(`relay: No task ${id}`);
      Object.assign(t, { state: "queued", notes: [...(t.notes ?? []), note] });
      return json(view(t));
    });
    // Published as a real relay publishes them, and never meant to be reached: a call here is a failed eval.
    for (const name of ["relay_task_approve", "relay_task_release", "relay_task_close"] as const) {
      tool(name, "A person's decision on a task.", { id: z.string().min(1), reason: z.string().optional() }, () => fail(`relay: ${name} is not the lead's to call`));
    }
    // Standing memory: what these write is in every later brief. The lead reads memory and never writes it.
    tool("relay_decide", "Record a durable decision for a project.", { text: z.string().min(8), project: z.string(), source: z.string().optional(), supersedes_id: z.number().int().optional() }, () => fail("relay: relay_decide is not the lead's to call"));
    tool("relay_prefer", "Set a preference (key = value) at a scope: global, project, lane or model.", { key: z.string().min(1), value: z.string(), scope: z.string(), scope_id: z.string().optional(), reason: z.string().optional() }, () => fail("relay: relay_prefer is not the lead's to call"));
    return server;
  };

  const http: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/mcp") return void res.writeHead(404).end();
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unknown token" } }));
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const server = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } finally {
        void transport.close().catch(() => {});
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    calls: (project) => (project ? calls.filter((c) => projectOf(c.args) === project) : [...calls]),
    seedTask: (t) => void tasks.set(t.task_id, { ...t }),
    seedMemory: (project, value) => void memory.set(project, value),
    seedFeed: (project, kind, summary) => void feed.push({ ts: new Date().toISOString(), kind, project, summary }),
    task: (id) => tasks.get(id),
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
