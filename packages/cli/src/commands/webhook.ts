/**
 * `relay webhook …`: outbound webhooks (docs/FEED.md "Outbound webhooks"). `add` prints the signing secret once;
 * `test` sends a signed `test.ping` so the receiver can check its verification code end to end.
 */
import type { Command } from "commander";
import { WEBHOOK_EVENT_KINDS, type PublicWebhook } from "@relay/core";
import { log, openReady } from "./_common.ts";

const line = (w: PublicWebhook): string => `${w.id}  ${(w.project ?? "*").padEnd(14)} ${w.active ? "active  " : "inactive"} ${w.events.join(",").padEnd(36)} ${w.has_bearer ? "bearer " : "       "} ${w.url}`;

export function registerWebhook(program: Command): void {
  const webhook = program.command("webhook").description("Outbound webhooks: signed POSTs to a URL when matching events are written (docs/FEED.md)");

  webhook
    .command("add")
    .requiredOption("--url <url>", "where to POST")
    .requiredOption("--events <list>", `comma-separated kinds (${WEBHOOK_EVENT_KINDS.slice(0, 6).join(", ")}, …), a prefix ending in '.', or '*'`)
    .option("--project <slug>", "only this project's events (default: every project)")
    .option("--bearer <token>", "sent as Authorization: Bearer on every delivery (e.g. the bot's routine key)")
    .option("--secret <secret>", "HMAC secret for X-Relay-Signature (generated and shown once when omitted)")
    .option("--json")
    .description("Register a webhook; the signing secret is shown once")
    .action(async (o: { url: string; events: string; project?: string; bearer?: string; secret?: string; json?: boolean }) => {
      const h = await openReady();
      try {
        const r = await h.client.addWebhook({ url: o.url, events: o.events.split(",").map((s) => s.trim()).filter(Boolean), project: o.project ?? null, bearer: o.bearer ?? null, ...(o.secret ? { secret: o.secret } : {}) });
        if (o.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        console.log(r.secret);
        log(`webhook ${r.webhook.id} -> ${r.webhook.url} for ${r.webhook.events.join(", ")}${r.webhook.project ? ` (project ${r.webhook.project})` : ""}`);
        log(o.secret ? "the secret you passed is the signing key" : "this is the only time the signing secret is shown; the receiver verifies X-Relay-Signature with it (docs/FEED.md)");
        log(`try it: relay webhook test ${r.webhook.id}`);
      } finally {
        await h.close();
      }
    });

  webhook
    .command("ls")
    .option("--project <slug>")
    .option("--json")
    .description("List webhooks (never the secret or bearer)")
    .action(async (o: { project?: string; json?: boolean }) => {
      const h = await openReady();
      try {
        const rows = await h.client.listWebhooks(o.project ? { project: o.project } : {});
        if (o.json) console.log(JSON.stringify(rows, null, 2));
        else {
          if (!rows.length) log("no webhooks; add one with: relay webhook add --url <url> --events pr.merged,run.failed");
          for (const w of rows) console.log(line(w));
        }
      } finally {
        await h.close();
      }
    });

  webhook
    .command("rm")
    .argument("<id>")
    .description("Remove a webhook")
    .action(async (id: string) => {
      const h = await openReady();
      try {
        const ok = await h.client.removeWebhook(id);
        if (!ok) {
          log(`no webhook ${id}`);
          process.exitCode = 1;
          return;
        }
        log(`removed ${id}`);
      } finally {
        await h.close();
      }
    });

  webhook
    .command("test")
    .argument("<id>")
    .option("--json")
    .description("Send a signed test.ping now and report the delivery")
    .action(async (id: string, o: { json?: boolean }) => {
      const h = await openReady();
      try {
        const r = await h.client.testWebhook(id);
        if (o.json) console.log(JSON.stringify(r, null, 2));
        else log(`${r.status} after ${r.attempts} attempt${r.attempts === 1 ? "" : "s"}${r.last_status ? ` (HTTP ${r.last_status})` : ""}${r.error ? `: ${r.error}` : ""}; delivery ${r.delivery_id}`);
        if (r.status !== "delivered") process.exitCode = 1;
      } finally {
        await h.close();
      }
    });
}
