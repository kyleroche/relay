/**
 * Claude Code: hooks live in ~/.claude/settings.json (`hooks.<Event>[]`, each with `hooks: [{type:'command'}]`),
 * user-scope MCP servers in ~/.claude.json (`mcpServers`). relay installs:
 *   SessionStart       -> relay brief for the cwd project (≤2.5K tokens, cached 10 min)
 *   UserPromptSubmit   -> relay recall for the prompt (≤1K tokens, only when the cwd is a linked repo)
 *   SessionEnd         -> relay capture on the transcript (runs detached; the session never waits on Sonnet)
 * Entries are recognised by the hook script path, so re-running replaces rather than duplicates them.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isRelayHookCommand, hookCommand, hookPaths, binOnPath, planFile, readJson, toJson, type HookContext, type InstallPlan, type Installer } from "./types.ts";

type HookEntry = { matcher?: string; hooks: Array<{ type: "command"; command: string; timeout?: number }> };

const EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd"] as const;

function stripRelay(entries: unknown): HookEntry[] {
  if (!Array.isArray(entries)) return [];
  return (entries as HookEntry[]).filter((e) => !(Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === "string" && isRelayHookCommand(h.command))));
}

export function relayClaudeHooks(ctx: HookContext): Record<(typeof EVENTS)[number], HookEntry> {
  const p = hookPaths(ctx);
  return {
    SessionStart: { hooks: [{ type: "command", command: hookCommand(ctx, p.sessionStart, "claude"), timeout: 20 }] },
    UserPromptSubmit: { hooks: [{ type: "command", command: hookCommand(ctx, p.userPrompt, "claude"), timeout: 10 }] },
    SessionEnd: { hooks: [{ type: "command", command: hookCommand(ctx, p.sessionEnd, "claude"), timeout: 10 }] },
  };
}

function settingsWith(ctx: HookContext, remove: boolean): string {
  const path = join(ctx.userHome, ".claude", "settings.json");
  const settings = readJson(path);
  const hooks = (settings.hooks && typeof settings.hooks === "object" ? { ...(settings.hooks as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const ours = relayClaudeHooks(ctx);
  for (const ev of EVENTS) {
    const kept = stripRelay(hooks[ev]);
    const next = remove ? kept : [...kept, ours[ev]];
    if (next.length) hooks[ev] = next;
    else delete hooks[ev];
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  return toJson(settings);
}

function claudeJsonWith(ctx: HookContext, remove: boolean): string {
  const path = join(ctx.userHome, ".claude.json");
  const cfg = readJson(path);
  const servers = (cfg.mcpServers && typeof cfg.mcpServers === "object" ? { ...(cfg.mcpServers as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (remove) delete servers.relay;
  else servers.relay = { type: "stdio", command: ctx.node, args: [hookPaths(ctx).mcpBin] };
  cfg.mcpServers = servers;
  return toJson(cfg);
}

export const claudeInstaller: Installer = {
  cli: "claude",
  detect: (ctx) => existsSync(join(ctx.userHome, ".claude")) || binOnPath("claude"),
  plan(ctx): InstallPlan {
    const p = hookPaths(ctx);
    return {
      cli: "claude",
      detected: this.detect(ctx),
      files: [planFile(join(ctx.userHome, ".claude", "settings.json"), settingsWith(ctx, false)), planFile(join(ctx.userHome, ".claude.json"), claudeJsonWith(ctx, false))],
      notes: [
        "SessionStart injects `relay brief` for the cwd project (≤2.5K tokens, cached 10 min); UserPromptSubmit injects `relay recall` for the prompt (≤1K tokens, linked repos only); SessionEnd runs `relay capture` detached.",
        `MCP server \`relay\` is registered in user scope; the equivalent command is: claude mcp add --scope user --transport stdio relay -- ${ctx.node} ${p.mcpBin}`,
      ],
    };
  },
  planRemove(ctx): InstallPlan {
    return {
      cli: "claude",
      detected: this.detect(ctx),
      files: [planFile(join(ctx.userHome, ".claude", "settings.json"), settingsWith(ctx, true)), planFile(join(ctx.userHome, ".claude.json"), claudeJsonWith(ctx, true))],
      notes: [],
    };
  },
};
