#!/usr/bin/env node
// UserPromptSubmit hook (Claude Code, Grok Build; Codex has no such hook): print the decisions and preferences
// that match the prompt so they are in context before the model answers. Budget: 1K tokens. Only runs in a linked
// repo, and only for prompts long enough to be about something (short acknowledgements and slash commands skip).
// Payload (stdin JSON) fields used: prompt, cwd.
import { cliName, linkedProject, readPayload, runRelay } from "./_lib.mjs";

const MAX_TOKENS = 1000;
const MIN_PROMPT_CHARS = 20;

const payload = readPayload();
const link = linkedProject(payload.cwd || process.cwd());
if (!link) process.exit(0);
const prompt = String(payload.prompt ?? payload.user_prompt ?? payload.input ?? "").trim();
if (prompt.length < MIN_PROMPT_CHARS || prompt.startsWith("/")) process.exit(0);

const text = runRelay(["recall", "--hook", "--project", link.project, "--cwd", link.root, "--max-tokens", String(MAX_TOKENS), "--lane", cliName(), "--", prompt.slice(0, 2000)], 10_000);
if (text.trim()) process.stdout.write(text);
