import { defineEvalConfig } from "eve/evals";
import { startFakeRelay } from "./lib/fake-relay.ts";

/**
 * These evals call a real model through AI Gateway, which is billed per token. Nothing runs them automatically:
 * `pnpm --filter @relay/lead eval` is a person's decision.
 *
 * `setup` runs before eve starts the local agent server in this same process, so the two variables set here are the
 * relay the lead under test connects to: a fake on localhost, never a real site. Tasks the evals "open" exist only
 * in its memory.
 */
export default defineEvalConfig({
  // Each eval is a handful of model calls with tool round-trips between them.
  timeoutMs: 180_000,
  maxConcurrency: 4,
  async setup() {
    const relay = await startFakeRelay();
    process.env.RELAY_SITE = relay.url;
    process.env.RELAY_TOKEN = relay.token;
    return { relay };
  },
  async teardown(context) {
    await context?.relay.close();
  },
});
