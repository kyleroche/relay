export * from "./types.ts";
export * from "./cache.ts";
export { claudeInstaller, relayClaudeHooks, relayStatusLine, readPreviousStatusLine } from "./claude.ts";
export { codexInstaller, relayCodexBlock, spliceTomlBlock, TOML_BEGIN, TOML_END } from "./codex.ts";
export { grokInstaller, relayGrokHooks } from "./grok.ts";

import { claudeInstaller } from "./claude.ts";
import { codexInstaller } from "./codex.ts";
import { grokInstaller } from "./grok.ts";
import type { CliName, HookContext, InstallPlan, Installer, PlanOptions } from "./types.ts";

export const installers: Record<CliName, Installer> = { claude: claudeInstaller, codex: codexInstaller, grok: grokInstaller };

/** Plans for every detected CLI, or only the named one (which is planned whether detected or not). */
export function planSetup(ctx: HookContext, opts: { only?: CliName; remove?: boolean } & PlanOptions = {}): InstallPlan[] {
  const list = opts.only ? [installers[opts.only]] : Object.values(installers);
  const plans: InstallPlan[] = [];
  for (const inst of list) {
    const detected = inst.detect(ctx);
    if (!detected && !opts.only) {
      plans.push({ cli: inst.cli, detected: false, files: [], notes: ["not detected (no config directory and not on PATH); pass --only " + inst.cli + " to install anyway"] });
      continue;
    }
    plans.push(opts.remove ? inst.planRemove(ctx) : inst.plan(ctx, { ...(opts.statusline !== undefined ? { statusline: opts.statusline } : {}) }));
  }
  return plans;
}
