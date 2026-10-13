/**
 * Grok Build: hooks are JSON files under ~/.grok/hooks/, one file per source; relay owns ~/.grok/hooks/relay.json
 * outright (SessionStart, UserPromptSubmit, Stop command hooks). The MCP server goes into `mcpServers.relay` of
 * ~/.grok/settings.json, which is what `grok mcp add` writes; the equivalent command is printed in the plan.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hookCommand, hookPaths, binOnPath, planFile, readJson, toJson, type HookContext, type InstallPlan, type Installer } from "./types.ts";

export function relayGrokHooks(ctx: HookContext): Record<string, unknown> {
  const p = hookPaths(ctx);
  const entry = (script: string, timeout: number) => [{ hooks: [{ type: "command", command: hookCommand(ctx, script, "grok"), timeout }] }];
  return {
    hooks: {
      SessionStart: entry(p.sessionStart, 20),
      UserPromptSubmit: entry(p.userPrompt, 10),
      Stop: entry(p.sessionEnd, 10),
    },
  };
}

function settingsWith(ctx: HookContext, remove: boolean): string {
  const cfg = readJson(join(ctx.userHome, ".grok", "settings.json"));
  const servers = (cfg.mcpServers && typeof cfg.mcpServers === "object" ? { ...(cfg.mcpServers as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (remove) delete servers.relay;
  else servers.relay = { type: "stdio", command: ctx.node, args: [hookPaths(ctx).mcpBin] };
  cfg.mcpServers = servers;
  return toJson(cfg);
}

export const grokInstaller: Installer = {
  cli: "grok",
  detect: (ctx) => existsSync(join(ctx.userHome, ".grok")) || binOnPath("grok"),
  plan(ctx): InstallPlan {
    const p = hookPaths(ctx);
    return {
      cli: "grok",
      detected: this.detect(ctx),
      files: [planFile(join(ctx.userHome, ".grok", "hooks", "relay.json"), toJson(relayGrokHooks(ctx))), planFile(join(ctx.userHome, ".grok", "settings.json"), settingsWith(ctx, false))],
      notes: [
        "SessionStart injects `relay brief` (≤2.5K tokens, cached 10 min); UserPromptSubmit injects `relay recall` (≤1K tokens, linked repos only); Stop runs `relay capture` detached (once per transcript, deduplicated by the capture log).",
        `MCP server \`relay\` is written to ~/.grok/settings.json; if your Grok Build keeps servers elsewhere run: grok mcp add relay -- ${ctx.node} ${p.mcpBin}`,
      ],
    };
  },
  planRemove(ctx): InstallPlan {
    const hooksPath = join(ctx.userHome, ".grok", "hooks", "relay.json");
    const files = [planFile(join(ctx.userHome, ".grok", "settings.json"), settingsWith(ctx, true))];
    if (existsSync(hooksPath)) files.push({ path: hooksPath, action: "update", content: toJson({ hooks: {} }) });
    return { cli: "grok", detected: this.detect(ctx), files, notes: ["~/.grok/hooks/relay.json is emptied rather than deleted; remove it by hand if you prefer."] };
  },
};
