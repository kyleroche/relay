import { randomBytes } from "node:crypto";
import { defineEvalConfig } from "eve/evals";
import { LEAD_WAKE_SECRET_ENV } from "@relay/core/lead/client.ts";
import { startFakeRelay } from "./lib/fake-relay.ts";

/**
 * These evals call a real model through AI Gateway, which is billed per token. Nothing runs them automatically:
 * `pnpm --filter @relay/lead eval` is a person's decision.
 *
 * `setup` runs before eve starts the local agent server in this same process, so the variables set here are the
 * relay the lead under test connects to (a fake on localhost, never a real site; tasks the evals "open" exist only
 * in its memory) and the secret its wake route checks, made up for this run, which `lib/wake.ts` signs with.
 */
export default defineEvalConfig({
  // Each eval is a handful of model calls with tool round-trips between them.
  timeoutMs: 180_000,
  maxConcurrency: 4,
  async setup() {
    const relay = await startFakeRelay();
    process.env.RELAY_SITE = relay.url;
    process.env.RELAY_TOKEN = relay.token;
    process.env[LEAD_WAKE_SECRET_ENV] = randomBytes(32).toString("hex");
    return { relay };
  },
  async teardown(context) {
    await context?.relay.close();
  },
});
