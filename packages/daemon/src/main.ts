/**
 * relay daemon: localhost/tailnet HTTP + SSE for the Mac/iPad app and the CLI. Phase 2 fills in tasks and
 * lanes; for now it exposes health, models, and guidance search so the app can be started early.
 *
 * Bind address: RELAY_BIND (default 127.0.0.1). Set it to the host's Tailscale IP to reach it from an iPad;
 * every request must carry `Authorization: Bearer <token>` from ~/.harness/daemon.json.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openHarness, retrieveGuidance, repo } from "@relay/core";

const h = openHarness();
const tokenPath = join(h.cfg.home, "daemon.json");
if (!existsSync(tokenPath)) writeFileSync(tokenPath, JSON.stringify({ token: randomBytes(24).toString("hex"), port: 7474 }, null, 2) + "\n", { mode: 0o600 });
const { token, port } = JSON.parse(readFileSync(tokenPath, "utf8")) as { token: string; port: number };
const bind = process.env.RELAY_BIND ?? "127.0.0.1";

const app = new Hono();
app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  if (c.req.header("authorization") !== `Bearer ${token}`) return c.text("unauthorized", 401);
  return next();
});
app.get("/health", (c) => c.json({ ok: true, graph: h.cfg.graph.name, bind, port }));
app.get("/models", async (c) => c.json(await repo.listModels(h.graph)));
app.get("/models/:provider/:name/search", async (c) => {
  const model = `${c.req.param("provider")}/${c.req.param("name")}`;
  const q = c.req.query("q") ?? "";
  return c.json(await retrieveGuidance(h, model, q, { k: Number(c.req.query("k") ?? 6) }));
});
app.get("/preferences", async (c) => c.json(await repo.listPreferences(h.graph)));

serve({ fetch: app.fetch, hostname: bind, port }, (info) => console.error(`[relay-daemon] listening on http://${info.address}:${info.port} (token in ${tokenPath})`));
