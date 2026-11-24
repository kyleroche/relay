/**
 * Whether an approved run is started now. A grant is for one run, so the rule that matters is the one that keeps a
 * second from starting by itself:
 *
 *   a start is marked in the task's thread before the sandbox is made, as the site's own profile, under a key made
 *   from the task, the grant and the try, so two instances that both look make one mark and one of them starts;
 *
 *   a start that did not come up (the sandbox was refused, a tool would not install) is marked failed, and only such
 *   a start is tried again, three times at most;
 *
 *   a start that is neither young nor marked failed may have run and spent, so nothing follows it: when its task is
 *   in the queue again, the owner is asked again.
 *
 * The marks are read from what the site wrote, never from a label: anyone who may label in a queue could take a label
 * off and have the run start again.
 *
 * Who is believed here is narrower than for a run's own reports. A paid run's lane works without the OS sandbox, in a
 * microVM whose firewall puts the board's credential on its requests, so whatever a fooled lane posts arrives as its
 * worker's profile, one of relay's own. A grant to spend and the marks that decide whether a sandbox starts therefore
 * count only from a trusted principal itself (a person at their own machine) or from the site's own profile, which
 * the site writes only after a signed-in person asked: never from a worker's profile.
 */
import type { MessageView, ThreadView } from "@vercel/board";
import { CLOUD_APPROVED, LABEL } from "../board/mapping.ts";
import { GRANT_SCHEMA, isDecidingActor, trustedBlocks, withoutBlocks, type GrantBlock } from "../board/schemas.ts";
import { grantDigest } from "../board/tasks.ts";

/** How long a start has to come up and claim its task before it is no longer "being started". */
export const CLOUD_START_GRACE_MS = 10 * 60_000;
export const CLOUD_MAX_STARTS = 3;

/** The hint on a task's root that a paid run was granted for it (`LABEL.cloud` in board/mapping.ts). */
export const CLOUD_LABEL = LABEL.cloud;
export { CLOUD_APPROVED };

export interface CloudMark {
  kind: "start" | "failed";
  /** The grant it ran under: the ID of the reply that carries it. */
  grant: string;
  n: number;
  at: string;
  /** On a start: the sandbox, and the word that says which instance wrote the mark. */
  sandbox?: string;
  nonce?: string;
  /** On a failure: what went wrong. */
  why?: string;
}

/** The key a start's mark is posted under: the same task, grant and try never make two. */
export const cloudStartKey = (task: string, grant: string, n: number): string => `relay-cloud:${task}:${grant}:${n}`;
export const cloudFailedKey = (task: string, grant: string, n: number): string => `relay-cloud-failed:${task}:${grant}:${n}`;

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);

export function cloudStartText(m: { grant: string; n: number; sandbox: string; capUsd: number; timeoutMs: number; nonce: string }): string {
  return `Cloud run, start ${m.n} under grant ${m.grant}: sandbox ${m.sandbox}, cap $${m.capUsd.toFixed(2)}, at most ${Math.round(m.timeoutMs / 60_000)} min. [${m.nonce}]`;
}
export function cloudFailedText(m: { grant: string; n: number; why: string }): string {
  return `Cloud run, start ${m.n} under grant ${m.grant} did not come up: ${oneLine(m.why, 600)}`;
}

/** A mark as one of the two lines above; undefined for any other text. */
export function parseCloudMark(text: string): Omit<CloudMark, "at"> | undefined {
  const line = text.trim();
  const start = /^Cloud run, start (\d+) under grant (\S+): sandbox (\S+), cap \$[\d.]+, at most \d+ min\. \[([0-9a-f]{4,32})\]$/.exec(line);
  if (start) return { kind: "start", n: Number(start[1]), grant: start[2]!, sandbox: start[3]!, nonce: start[4]! };
  const failed = /^Cloud run, start (\d+) under grant (\S+) did not come up: (.*)$/.exec(line);
  return failed ? { kind: "failed", n: Number(failed[1]), grant: failed[2]!, why: failed[3]! } : undefined;
}

/** The marks the site left in a thread, oldest first. */
export function cloudMarksOf(thread: Pick<ThreadView, "replies">, trusted: readonly string[]): CloudMark[] {
  return thread.replies.flatMap((m: MessageView) => {
    // an edit keeps its author, and a board may let another profile of the same principal make it: an edited mark is none
    if (m.deleted || m.editedAt || !isDecidingActor(m.by.actor, trusted)) return [];
    const mark = parseCloudMark(withoutBlocks(m.text));
    return mark ? [{ ...mark, at: m.createdAt }] : [];
  });
}

/**
 * The paid run a trusted person approved for this task's text as it stands: the cap, and the reply that carries the
 * grant. The last one counts, as in `grantsOf`; a grant for an earlier wording is none, and so is one a worker's
 * profile wrote.
 */
export function cloudGrantOf(thread: ThreadView, trusted: readonly string[]): { id: string; capUsd: number; at: string } | undefined {
  const digest = grantDigest(thread);
  const last = trustedBlocks<GrantBlock>(thread.replies, GRANT_SCHEMA, trusted, { deciding: true })
    .filter((g) => g.data.digest === digest && typeof g.data.cloud_cap_usd === "number" && Number.isFinite(g.data.cloud_cap_usd) && g.data.cloud_cap_usd > 0)
    .at(-1);
  const reply = last ? thread.replies[last.index] : undefined;
  return last && reply ? { id: reply.id, capUsd: last.data.cloud_cap_usd!, at: reply.createdAt } : undefined;
}

export type CloudStart =
  /** Start try `n` now. */
  | { start: number }
  /**
   * starting: a start is young and has not failed. ended: the grant's run started and nothing says it failed to come
   * up, so it is spent. gave-up: every try failed to come up.
   */
  | { wait: "starting" | "ended" | "gave-up"; n: number; why?: string };

export function cloudStart(marks: readonly CloudMark[], grant: string, now: number): CloudStart {
  const failed = (m: CloudMark): CloudMark | undefined => marks.find((f) => f.kind === "failed" && f.grant === m.grant && f.n === m.n);
  const starts = marks.filter((m) => m.kind === "start");
  // one sandbox per task at a time: a young start under any grant is still coming up
  const young = starts.find((m) => !failed(m) && now - new Date(m.at).getTime() < CLOUD_START_GRACE_MS);
  if (young) return { wait: "starting", n: young.n };
  const mine = starts.filter((m) => m.grant === grant).sort((a, z) => a.n - z.n);
  const last = mine.at(-1);
  if (!last) return { start: 1 };
  const why = failed(last)?.why;
  if (why === undefined) return { wait: "ended", n: last.n };
  return last.n >= CLOUD_MAX_STARTS ? { wait: "gave-up", n: last.n, why } : { start: last.n + 1 };
}
