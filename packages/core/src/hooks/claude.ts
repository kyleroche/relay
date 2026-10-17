/**
 * Claude Code: hooks live in ~/.claude/settings.json (`hooks.<Event>[]`, each with `hooks: [{type:'command'}]`),
 * user-scope MCP servers in ~/.claude.json (`mcpServers`). relay installs:
 *   SessionStart       -> relay brief for the cwd project (≤2.5K tokens, cached 10 min)
 *   UserPromptSubmit   -> relay recall for the prompt (≤1K tokens, only when the cwd is a linked repo)
 *   SessionEnd         -> relay capture on the transcript (runs detached; the session never waits on Sonnet)
 *   statusLine         -> statusline.mjs saves the plan meters Claude Code reports (rate_limits on stdin) under
 *                         ~/.harness/meters/claude.json, then runs the status line that was there before, if any
 * Entries are recognised by the hook script path, so re-running replaces rather than duplicates them. Claude Code
 * has one `statusLine.command`; a foreign one is remembered in ~/.harness/statusline.prev.json before it is replaced,
 * statusline.mjs delegates to it, and `--remove` puts it back.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isRelayHookCommand, isRelayStatusLineCommand, hookCommand, hookPaths, binOnPath, planDelete, planFile, readJson, statusLineCommand, statusLinePrevPath, toJson, type HookContext, type InstallPlan, type Installer, type PlanOptions, type PlannedFile } from "./types.ts";

type HookEntry = { matcher?: string; hooks: Array<{ type: "command"; command: string; timeout?: number }> };
type StatusLine = { type?: string; command?: string } & Record<string, unknown>;

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

/** The `statusLine` entry relay installs. */
export const relayStatusLine = (ctx: HookContext): { type: "command"; command: string } => ({ type: "command", command: statusLineCommand(ctx) });

const foreignStatusLine = (v: unknown): StatusLine | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const s = v as StatusLine;
  return typeof s.command === "string" && s.command.trim() && !isRelayStatusLineCommand(s.command) ? s : undefined;
};

const isRelayStatusLine = (v: unknown): boolean => !!v && typeof v === "object" && typeof (v as StatusLine).command === "string" && isRelayStatusLineCommand((v as StatusLine).command!);

/** The previous status line as recorded by an earlier setup, or undefined. */
export function readPreviousStatusLine(ctx: Pick<HookContext, "relayHome">): StatusLine | undefined {
  try {
    const j = readJson(statusLinePrevPath(ctx));
    return typeof j.command === "string" && j.command.trim() ? (j as StatusLine) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * settings.json with relay's hooks (and, unless `statusline` is false, its status line) merged in or removed. The
 * second element is what else changes: ~/.harness/statusline.prev.json is written when a foreign status line is
 * replaced and deleted when nothing refers to it any more.
 */
function settingsWith(ctx: HookContext, remove: boolean, statusline: boolean): { content: string; extra: PlannedFile[] } {
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

  const extra: PlannedFile[] = [];
  const prevPath = statusLinePrevPath(ctx);
  if (remove) {
    if (isRelayStatusLine(settings.statusLine)) {
      const prev = readPreviousStatusLine(ctx);
      if (prev) settings.statusLine = prev;
      else delete settings.statusLine;
      extra.push(...planDelete(prevPath));
    }
  } else if (statusline) {
    const foreign = foreignStatusLine(settings.statusLine);
    if (foreign) {
      extra.push(planFile(prevPath, toJson(foreign)));
      settings.statusLine = relayStatusLine(ctx);
    } else if (!isRelayStatusLine(settings.statusLine)) {
      settings.statusLine = relayStatusLine(ctx);
      extra.push(...planDelete(prevPath)); // nothing to delegate to: a remembered command would be stale
    }
  }
  return { content: toJson(settings), extra };
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
  plan(ctx, opts: PlanOptions = {}): InstallPlan {
    const p = hookPaths(ctx);
    const statusline = opts.statusline !== false;
    const settings = settingsWith(ctx, false, statusline);
    const notes = [
      "SessionStart injects `relay brief` for the cwd project (≤2.5K tokens, cached 10 min); UserPromptSubmit injects `relay recall` for the prompt (≤1K tokens, linked repos only); SessionEnd runs `relay capture` detached.",
      `MCP server \`relay\` is registered in user scope; the equivalent command is: claude mcp add --scope user --transport stdio relay -- ${ctx.node} ${p.mcpBin}`,
    ];
    if (statusline) {
      notes.push(
        `statusLine: Claude Code runs ${p.statusLine} on every status refresh. The web app's plan meters (5-hour, weekly) need Claude Code's own rate-limit numbers, which it hands only to its status line; the script writes them to ${join(ctx.relayHome, "meters", "claude.json")} and nothing else, and \`relay work\` sends them with its heartbeat. --no-statusline skips this.`,
      );
      const foreign = settings.extra.find((f) => f.action !== "delete");
      if (foreign) notes.push(`Your current status line is kept: it is recorded in ${foreign.path} and relay's script runs it and passes its output through. \`relay setup --remove\` restores it.`);
    }
    return {
      cli: "claude",
      detected: this.detect(ctx),
      files: [planFile(join(ctx.userHome, ".claude", "settings.json"), settings.content), planFile(join(ctx.userHome, ".claude.json"), claudeJsonWith(ctx, false)), ...settings.extra],
      notes,
    };
  },
  planRemove(ctx): InstallPlan {
    const settings = settingsWith(ctx, true, true);
    return {
      cli: "claude",
      detected: this.detect(ctx),
      files: [planFile(join(ctx.userHome, ".claude", "settings.json"), settings.content), planFile(join(ctx.userHome, ".claude.json"), claudeJsonWith(ctx, true)), ...settings.extra],
      notes: [],
    };
  },
};
