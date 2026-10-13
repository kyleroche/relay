#!/usr/bin/env node
// SessionEnd (Claude Code, Codex) / Stop (Grok Build) hook: run `relay capture` on the session transcript, detached,
// so the session never waits on the Sonnet call. Output goes to <RELAY_HOME>/cache/capture.log. Per-turn Stop
// hooks are cheap because capture keeps a byte offset per transcript and only reads the new turns.
// Payload (stdin JSON) fields used: transcript_path (or rollout_path / session_path), session_id, cwd.
import { existsSync } from "node:fs";
import { cliName, linkedProject, readPayload, spawnRelayDetached } from "./_lib.mjs";

const payload = readPayload();
const link = linkedProject(payload.cwd || process.cwd());
if (!link) process.exit(0);
const transcript = payload.transcript_path ?? payload.rollout_path ?? payload.session_path ?? payload.transcript;
if (typeof transcript !== "string" || !existsSync(transcript)) process.exit(0);

const args = ["capture", "--hook", "--transcript", transcript, "--project", link.project, "--cwd", link.root, "--source", cliName()];
if (payload.session_id) args.push("--session", String(payload.session_id));
spawnRelayDetached(args, "capture.log");
