import { defineAgent } from "eve";

/**
 * eve's own default (what `eve init` writes and what an agent without this file runs on), so the lead starts on a
 * model the installed framework is known to work with. RELAY_LEAD_MODEL is any Vercel AI Gateway model id. It is read
 * when the app is built: eve compiles a model id into the build, so a new value takes a new deployment.
 */
const DEFAULT_MODEL = "openai/gpt-6-luna-fast";

export default defineAgent({
  model: process.env.RELAY_LEAD_MODEL?.trim() || DEFAULT_MODEL,
  reasoning: "high",
  // The lead plans and decides. Without eve's shell, file and web tools it has nothing to do work with: what it can
  // reach is `no_reply` and the relay tools the connection allows.
  defaultTools: false,
  // A project's wake session lives for months and every wake-up sends its whole history. eve compacts history near
  // the context window it is told, so this is told a small one: a wake-up then carries at most about 90,000 tokens
  // however long the session has run, instead of growing toward the model's real window (ten times that on the
  // default model). These are the only model calls relay pays for by the token.
  modelContextWindowTokens: 100_000,
});
