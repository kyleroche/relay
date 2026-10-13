/**
 * `relay capture --transcript <path>`: extract decisions from a session transcript (session-end hooks call this
 * detached). Progress per transcript is kept in ~/.harness/cache/capture-state.json so per-turn Stop hooks only
 * process the new turns and a re-run on a finished transcript is a no-op.
 */
import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureDecisions, relayHome, repo } from "@relay/core";
import { hookSafe, log, openReady, resolveProject } from "./_common.ts";

interface CaptureState {
  transcripts: Record<string, { offset: number; updated_at: string; decisions: number }>;
}

function statePath(): string {
  return join(relayHome(), "cache", "capture-state.json");
}

export function readCaptureState(): CaptureState {
  const p = statePath();
  if (!existsSync(p)) return { transcripts: {} };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CaptureState;
  } catch {
    return { transcripts: {} };
  }
}

export function writeCaptureState(s: CaptureState): void {
  const p = statePath();
  mkdirSync(join(relayHome(), "cache"), { recursive: true });
  // keep the file small: drop entries older than 30 days
  const cutoff = Date.now() - 30 * 86_400_000;
  for (const [k, v] of Object.entries(s.transcripts)) if (Date.parse(v.updated_at) < cutoff) delete s.transcripts[k];
  writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
}

export function registerCapture(program: Command): void {
  program
    .command("capture")
    .requiredOption("--transcript <path>", "transcript file (JSONL or text) written by the CLI")
    .option("--project <slug>")
    .option("--cwd <path>", "repo the session ran in (default: process cwd)")
    .option("--source <cli>", "claude | codex | grok", "claude")
    .option("--session <id>", "session id kept as source_ref (default: the transcript path)")
    .option("--gate <command>", "gate command for segments (default: config capture.gateCommand, else the built-in rule)")
    .option("--all", "ignore the stored offset and re-read the whole transcript")
    .option("--dry-run", "gate only; no model call, nothing written")
    .option("--hook", "hook mode: silent unless the cwd is linked, never fails")
    .description("Extract durable decisions from a session transcript with the Sonnet lane (no tools) and store them")
    .action(async (o: { transcript: string; project?: string; cwd?: string; source: string; session?: string; gate?: string; all?: boolean; dryRun?: boolean; hook?: boolean }) => {
      const hook = !!o.hook;
      await hookSafe(hook, async () => {
        if (!existsSync(o.transcript)) {
          if (hook) return;
          throw new Error(`no such transcript: ${o.transcript}`);
        }
        const ref = resolveProject({ ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.project ? { project: o.project } : {}) });
        if (hook && !ref.linked && !o.project) return;
        const state = readCaptureState();
        const prev = state.transcripts[o.transcript];
        const offset = o.all ? 0 : prev?.offset ?? 0;
        const h = await openReady();
        try {
          const project = ref.slug && (await repo.getProject(h.db, ref.slug)) ? ref.slug : null;
          if (!project && hook) return;
          const r = await captureDecisions(h, o.transcript, {
            project,
            source: o.source,
            sourceRef: o.session ?? o.transcript,
            cwd: ref.root,
            offset,
            log,
            ...(o.gate ?? h.cfg.captureGate ? { gateCommand: (o.gate ?? h.cfg.captureGate)! } : {}),
            ...(o.dryRun ? { dryRun: true } : {}),
          });
          if (!o.dryRun) {
            state.transcripts[o.transcript] = { offset: r.bytes, updated_at: new Date().toISOString(), decisions: (prev?.decisions ?? 0) + r.added.length };
            writeCaptureState(state);
          }
          console.log(JSON.stringify({ project, offset, bytes: r.bytes, turns: r.turns, segments: r.segments, gated: r.gated, calls: r.calls, added: r.added.map((d) => ({ id: d.id, text: d.text })), superseded: r.superseded, skippedDuplicates: r.skippedDuplicates, tokensIn: r.tokensIn, tokensOut: r.tokensOut }, null, hook ? 0 : 2));
        } finally {
          await h.close();
        }
      });
    });
}
