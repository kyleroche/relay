/**
 * `relay invite …`: one-time codes that let a machine or bot get a token with no approval step
 * (docs/INTEGRATIONS.md, "Invite codes"). `create` prints the code once; the redeemer runs
 * `relay setup --site <url> --invite <code>` or posts grant `urn:relay:invite` to /oauth/token and receives a token
 * named `oauth:<name>` with exactly the invite's scopes. Works locally against the database and in site mode against
 * POST /api/v1/invites (scope tokens:write).
 */
import type { Command } from "commander";
import { parseDuration, TOKEN_SCOPE_DESCRIPTIONS, TOKEN_SCOPES, type InviteRow } from "@relay/core";
import { log, openReady } from "./_common.ts";

const line = (i: InviteRow): string =>
  `${i.id}  ${i.name.padEnd(20)} ${i.scopes.join(",").padEnd(40)} uses ${i.uses_left}/${i.max_uses}  expires ${i.expires_at.slice(0, 16)}${i.revoked_at ? "  REVOKED" : ""}${i.last_redeemed_at ? `  last ${i.last_redeemed_at.slice(0, 16)}` : ""}`;

export function registerInvite(program: Command): void {
  const invite = program.command("invite").description("Invite codes: approval in advance for a machine or bot (redeemed with relay setup --site <url> --invite <code>)");

  invite
    .command("create")
    .requiredOption("--for <name>", "who it is for; the token will be named oauth:<name>, e.g. woodhouse")
    .requiredOption("--scopes <list>", `comma-separated: ${TOKEN_SCOPES.join(", ")}`)
    .option("--expires <duration>", "how long the code works: 30m, 24h, 7d (default 24h)", "24h")
    .option("--uses <n>", "how many times it may be redeemed (default 1)", "1")
    .option("--json", "print the invite and code as JSON")
    .description("Mint a one-time invite code and print it once")
    .addHelpText("after", `\nScopes:\n${TOKEN_SCOPES.map((s) => `  ${s.padEnd(16)} ${TOKEN_SCOPE_DESCRIPTIONS[s]}`).join("\n")}\n\nRedeem: relay setup --site <url> --invite <code>   (or POST /oauth/token grant_type=urn:relay:invite invite=<code>)`)
    .action(async (o: { for: string; scopes: string; expires: string; uses: string; json?: boolean }) => {
      const expiresInSeconds = parseDuration(o.expires);
      if (!expiresInSeconds) throw new Error(`--expires must be a duration like 30m, 24h or 7d (got ${o.expires})`);
      const uses = Number(o.uses);
      if (!Number.isInteger(uses) || uses < 1) throw new Error(`--uses must be a positive integer (got ${o.uses})`);
      const h = await openReady();
      try {
        const { code, invite: row } = await h.client.createInvite({ name: o.for, scopes: o.scopes.split(",").map((s) => s.trim()).filter(Boolean), expiresInSeconds, uses });
        if (o.json) {
          console.log(JSON.stringify({ ...row, code }, null, 2));
          return;
        }
        console.log(code);
        log(`invite ${row.id} for ${row.name}: ${row.scopes.join(", ")}; ${row.max_uses} use(s), expires ${row.expires_at}`);
        log("this is the only time the code is shown; the redeemer runs:");
        log(`  relay setup --site ${h.mode === "site" ? h.client.site : "<site>"} --invite ${code}`);
      } finally {
        await h.close();
      }
    });

  invite
    .command("ls")
    .option("--all", "include spent, expired and revoked invites")
    .description("List invites (never the code)")
    .action(async (o: { all?: boolean }) => {
      const h = await openReady();
      try {
        const rows = await h.client.listInvites({ includeSpent: !!o.all });
        if (!rows.length) {
          log("no live invites; mint one with: relay invite create --for <name> --scopes feed:read");
          return;
        }
        for (const i of rows) console.log(line(i));
      } finally {
        await h.close();
      }
    });

  invite
    .command("revoke")
    .argument("<id-or-name>")
    .description("Revoke an invite; an unredeemed code stops working at once")
    .action(async (idOrName: string) => {
      const h = await openReady();
      try {
        const row = await h.client.revokeInvite(idOrName);
        if (!row) {
          log(`no live invite matches '${idOrName}'`);
          process.exitCode = 1;
          return;
        }
        log(`revoked ${row.id} (${row.name})`);
      } finally {
        await h.close();
      }
    });
}
