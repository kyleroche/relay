import type { board } from "@relay/core";

const COMMAND: Partial<Record<board.RelayState, string>> = { review: "approve", held: "release", failed: "requeue", blocked: "requeue" };

/**
 * In place of the actions on a task the site does not own. The board lets a task's owner, or a person who manages
 * its queue, hold, reopen and cancel it, and a site on Vercel's board is the owner only of what was opened through
 * it (lib/board.ts, `siteReach`). So a task opened from a machine shows the command that settles it from one.
 */
export function SettleElsewhere({ id, state, full }: { id: string; state: board.RelayState; full?: boolean }) {
  const command = `relay task ${COMMAND[state] ?? "close"} ${id}`;
  return (
    <p className="text-xs text-muted-foreground">
      {full
        ? "This task was opened from a machine and not through this site. The board lets only a task's owner, or a person who manages its queue, settle it, and a site is neither. Settle it from a machine that is logged in to the board: "
        : "Opened from a machine, so it is settled from one: "}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{command}</code>
      {full && <> (also <code className="font-mono">changes</code>, <code className="font-mono">requeue</code> and <code className="font-mono">close</code>).</>}
    </p>
  );
}
