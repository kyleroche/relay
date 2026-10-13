/**
 * Codex: one TOML file, ~/.codex/config.toml. relay owns a block between `# relay:begin` and `# relay:end`
 * holding `[mcp_servers.relay]` (stdio) and `[[hooks.SessionStart]]`. Codex has no UserPromptSubmit hook, so
 * per-prompt recall is not installed there; the MCP tools cover it. The block is replaced in place on re-runs and
 * appended on first install, so no TOML parser is needed and nothing outside the block is touched.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hookCommand, hookPaths, onPath, planFile, type HookContext, type InstallPlan, type Installer } from "./types.ts";

export const TOML_BEGIN = "# relay:begin (managed by `relay setup`; edits inside this block are overwritten)";
export const TOML_END = "# relay:end";

const tomlStr = (s: string): string => JSON.stringify(s);

export function relayCodexBlock(ctx: HookContext): string {
  const p = hookPaths(ctx);
  return [
    TOML_BEGIN,
    "[mcp_servers.relay]",
    `command = ${tomlStr(ctx.node)}`,
    `args = [${tomlStr(p.mcpBin)}]`,
    "",
    "[[hooks.SessionStart]]",
    `command = ${tomlStr(hookCommand(ctx, p.sessionStart, "codex"))}`,
    "",
    "[[hooks.SessionEnd]]",
    `command = ${tomlStr(hookCommand(ctx, p.sessionEnd, "codex"))}`,
    TOML_END,
  ].join("\n");
}

/** Replace or append relay's block; with `block` undefined the block is removed. */
export function spliceTomlBlock(text: string, block: string | undefined): string {
  const b = text.indexOf(TOML_BEGIN);
  const e = b >= 0 ? text.indexOf(TOML_END, b) : -1;
  if (b >= 0 && e >= 0) {
    const before = text.slice(0, b).replace(/\n+$/, "");
    const after = text.slice(e + TOML_END.length).replace(/^\n+/, "");
    if (!block) return [before, after].filter(Boolean).join("\n\n") + (before || after ? "\n" : "");
    return [before, block, after].filter(Boolean).join("\n\n") + "\n";
  }
  if (!block) return text;
  const base = text.replace(/\n+$/, "");
  return (base ? base + "\n\n" : "") + block + "\n";
}

export const codexInstaller: Installer = {
  cli: "codex",
  detect: (ctx) => existsSync(join(ctx.userHome, ".codex")) || onPath("codex"),
  plan(ctx): InstallPlan {
    const path = join(ctx.userHome, ".codex", "config.toml");
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    const notes = [
      "SessionStart injects `relay brief` for the cwd project (≤2.5K tokens, cached 10 min); SessionEnd runs `relay capture` detached.",
      "Codex has no UserPromptSubmit hook: per-prompt recall is not available there; the `relay_recall` MCP tool covers it.",
      "The block appends top-level tables; keep your own tables above `# relay:begin` so they are not read as part of relay's.",
    ];
    if (/^\s*\[mcp_servers\.relay\]/m.test(spliceTomlBlock(current, undefined))) notes.push("config.toml already defines [mcp_servers.relay] outside relay's block; remove one of the two.");
    return { cli: "codex", detected: this.detect(ctx), files: [planFile(path, spliceTomlBlock(current, relayCodexBlock(ctx)))], notes };
  },
  planRemove(ctx): InstallPlan {
    const path = join(ctx.userHome, ".codex", "config.toml");
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    return { cli: "codex", detected: this.detect(ctx), files: existsSync(path) ? [planFile(path, spliceTomlBlock(current, undefined))] : [], notes: [] };
  },
};
