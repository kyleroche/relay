/**
 * `relay token …`: mint, list and revoke bearer tokens for the web app and the HTTP MCP server. The plaintext is
 * printed once by `create`; only its hash reaches the database (`tokens` table, migration 003).
 */
import type { Command } from "commander";
import { repo, TOKEN_SCOPES } from "@relay/core";
import { humanActor, log, openReady } from "./_common.ts";

export function registerToken(program: Command): void {
  const token = program.command("token").description("Bearer tokens for the web API and the HTTP MCP server (hash stored, plaintext shown once)");

  token
    .command("create")
    .requiredOption("--name <name>", "what the token is for, e.g. ci-runner")
    .requiredOption("--scopes <list>", `comma-separated: ${TOKEN_SCOPES.join(", ")}`)
    .option("--by <actor>", "who minted it", humanActor())
    .option("--json", "print the row and token as JSON")
    .description("Mint a token and print it once")
    .action(async (o: { name: string; scopes: string; by: string; json?: boolean }) => {
      const h = await openReady();
      try {
        const { token: plaintext, row } = await repo.createToken(h.db, { name: o.name, scopes: o.scopes.split(","), createdBy: o.by });
        if (o.json) {
          console.log(JSON.stringify({ ...row, token: plaintext }, null, 2));
          return;
        }
        console.log(plaintext);
        log(`token ${row.id} (${row.name}) scopes: ${row.scopes.join(", ")}`);
        log("this is the only time the token is shown; store it in the caller's secret store");
      } finally {
        await h.close();
      }
    });

  token
    .command("ls")
    .option("--all", "include revoked tokens")
    .description("List tokens (never the secret)")
    .action(async (o: { all?: boolean }) => {
      const h = await openReady();
      try {
        const rows = await repo.listTokens(h.db, { includeRevoked: !!o.all });
        if (!rows.length) {
          log("no tokens; mint one with: relay token create --name <n> --scopes feed:read");
          return;
        }
        for (const t of rows) console.log(`${t.id}  ${t.name.padEnd(20)} ${t.scopes.join(",").padEnd(40)} created ${t.created_at.slice(0, 10)}  last used ${t.last_used_at?.slice(0, 16) ?? "-"}${t.revoked_at ? "  REVOKED" : ""}`);
      } finally {
        await h.close();
      }
    });

  token
    .command("revoke")
    .argument("<id-or-name>")
    .description("Revoke a token; the web app stops accepting it immediately")
    .action(async (idOrName: string) => {
      const h = await openReady();
      try {
        const row = await repo.revokeToken(h.db, idOrName);
        if (!row) {
          log(`no live token matches '${idOrName}'`);
          process.exitCode = 1;
          return;
        }
        log(`revoked ${row.id} (${row.name})`);
      } finally {
        await h.close();
      }
    });
}
