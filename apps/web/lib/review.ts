/**
 * What a task in review asks a person to approve, and the words for it. On its own, with no imports, so the client
 * components that draw the buttons can use it (`reviewKind` in lib/tasks.ts decides which one a task is).
 *
 *   pr        a pull request to squash-merge
 *   plan      a proposed plan: approving opens its tasks, and nothing was opened before
 *   report    what the lane wrote is the deliverable; there is nothing to merge
 *   outputs   files attached to the thread (the nodes lane)
 */
export type ReviewKind = "pr" | "plan" | "report" | "outputs";

export interface ApproveCopy {
  /** The button. */
  label: string;
  /** The button once armed: the second click does it. */
  armed: string;
  /** The line beside an armed button: what the second click does. */
  hint: string;
  pending: string;
  /** Shown when the approval went through and the action sent no message of its own. */
  done: string;
  /** What a note sent back does, in the request-changes sheet. */
  sendBack: string;
}

export function approveCopy(kind: ReviewKind, pr: number | null): ApproveCopy {
  switch (kind) {
    case "pr":
      return { label: "Approve and merge", armed: `Merge #${pr} now`, hint: "Click again to squash-merge; the branch is deleted afterwards.", pending: "Merging…", done: "Approved.", sendBack: `Your note goes in the task's thread and as a comment on pull request #${pr}, and the task goes back to the queue: the next run reads the whole thread and pushes to the same pull request.` };
    case "plan":
      return { label: "Approve plan", armed: "Open its tasks now", hint: "Click again to open the plan's tasks, each waiting for what it needs. Nothing was opened yet.", pending: "Opening…", done: "Plan approved.", sendBack: "Your note goes in the task's thread and the task goes back to the queue to be planned again: the next run reads the whole thread and proposes a new plan. Nothing of this plan was opened." };
    case "report":
      return { label: "Mark as read", armed: "Mark as read now", hint: "Click again to complete the task. There is no pull request: the report in the thread is the deliverable.", pending: "Completing…", done: "Marked as read.", sendBack: "Your note goes in the task's thread and the task goes back to the queue: the next run reads the whole thread and writes the report again." };
    case "outputs":
      return { label: "Approve outputs", armed: "Approve now", hint: "Click again to accept the outputs and complete the task.", pending: "Approving…", done: "Outputs approved.", sendBack: "Your note goes in the task's thread, and the task goes back to the queue: the next run reads the whole thread." };
  }
}
