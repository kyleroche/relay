#!/usr/bin/env node
// SessionStart hook (Claude Code, Codex, Grok Build): print the project's brief so it lands in the session's
// context. Budget: 2.5K tokens. Cached per project for ten minutes, so most starts never spawn the CLI.
// Silent when the cwd is not a linked repo. Payload (stdin JSON) fields used: cwd.
import { briefCacheKey, cliName, linkedProject, readCachedBrief, readPayload, runRelay } from "./_lib.mjs";

const INTENT = "session start";
const MAX_TOKENS = 2500;

const payload = readPayload();
const link = linkedProject(payload.cwd || process.cwd());
if (!link) process.exit(0);

const lane = cliName();
const cached = readCachedBrief(link.project, briefCacheKey(INTENT, MAX_TOKENS, "", lane));
const text = cached ? cached.text : runRelay(["brief", "--hook", "--project", link.project, "--cwd", link.root, "--max-tokens", String(MAX_TOKENS), "--lane", lane, "--", INTENT], 15_000);
if (text.trim()) process.stdout.write(`# relay brief for ${link.project}\n\n${text.trimEnd()}\n`);
