#!/usr/bin/env node
/**
 * A minimal relay worker over MCP (docs/WORKER-AGENTS.md): connect to <site>/mcp with a bearer token, register, run
 * the loop, do the job from job.mjs. Node 24, one dependency.
 *
 *   RELAY_SITE=https://relay.example.com RELAY_TOKEN=rly_… RELAY_LANES=embroidery node worker.mjs
 *
 * Environment: RELAY_SITE (required), RELAY_TOKEN (required: a token with work:claim assets:write assets:read
 * memory:read, from the device flow or an invite), RELAY_WORKER_NAME (default: the hostname), RELAY_LANES
 * (comma-separated, default embroidery), RELAY_LABELS (comma-separated, e.g. app:stitchwerx,machine:pe800),
 * RELAY_INTERVAL and RELAY_MAX_INTERVAL (seconds; 15 and 300), RELAY_ONCE=1 (one tick, then exit).
 */
import { hostname } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLoop, parseResult } from "./loop.mjs";
import { doJob } from "./job.mjs";

const env = process.env;
const site = (env.RELAY_SITE ?? "").replace(/\/+$/, "");
const token = env.RELAY_TOKEN ?? "";
if (!site || !token) {
  console.error("RELAY_SITE and RELAY_TOKEN are required (docs/WORKER-AGENTS.md, 'Get access').");
  process.exit(2);
}
const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const seconds = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) * 1000 : d);
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

const client = new Client({ name: env.RELAY_WORKER_NAME ?? "worker-agent-example", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${site}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
await client.connect(transport);

const call = async (name, args) => parseResult(await client.callTool({ name, arguments: args }));
const who = await call("relay_whoami", {});
if (!who.authenticated) throw new Error(`relay rejected the token: ${JSON.stringify(who)}`);
log(`connected to ${site} as ${who.name} (${who.scopes.join(" ")})`);
for (const s of ["work:claim", "assets:write"]) if (!who.scopes.includes(s)) log(`warning: the token lacks ${s}; the loop will fail at the step that needs it`);

const loop = createLoop({
  call,
  doJob,
  name: env.RELAY_WORKER_NAME ?? hostname().split(".")[0],
  host: hostname(),
  lanes: list(env.RELAY_LANES).length ? list(env.RELAY_LANES) : ["embroidery"],
  labels: list(env.RELAY_LABELS),
  version: "worker-agent-example/0.1.0",
  log,
  timing: { interval: seconds(env.RELAY_INTERVAL, 15_000), maxInterval: seconds(env.RELAY_MAX_INTERVAL, 300_000) },
});

const ctl = new AbortController();
const stop = () => {
  log("stopping after the current step");
  ctl.abort();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  if (env.RELAY_ONCE) {
    await loop.register();
    const t = await loop.tick();
    log(t.claimed ? `ran one task: ${JSON.stringify(t.result)}` : `nothing to claim (version ${t.bell.version}, ${t.bell.queued} queued)`);
    await loop.shutdown();
  } else {
    await loop.run({ signal: ctl.signal });
  }
} finally {
  await client.close().catch(() => {});
}
