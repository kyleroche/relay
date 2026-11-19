"use client";

import { Check, GitMerge, MessageSquareWarning } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveTaskAction, requestChangesAction, type TaskActionResult } from "@/app/tasks/actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * The two decisions on a task in review. Approve merges the pull request the task waits on (or, with `pr` null,
 * accepts the outputs attached to its thread) in two clicks: the first arms it, the second sends. Request changes
 * opens a sheet for the note, like the Access page's forms (DESIGN.md, item 7). Both call the same core functions the
 * API and the MCP tools use. Renders into the parent's flex-wrap row: the buttons inline, the outcome on a full-width
 * line under them.
 */
export function ReviewActions({ taskId, pr, canWrite, size = "default" }: { taskId: string; pr: number | null; canWrite: boolean; size?: "default" | "sm" }) {
  const router = useRouter();
  const [result, setResult] = useState<TaskActionResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const disabled = !canWrite || pending;

  const approve = () => {
    if (pending) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    start(async () => {
      const r = await approveTaskAction(taskId);
      setResult(r);
      setConfirm(false);
      router.refresh();
    });
  };

  const send = () => {
    if (pending) return;
    start(async () => {
      const r = await requestChangesAction(taskId, note);
      setResult(r);
      if (r.ok) {
        setNote("");
        setOpen(false);
      }
      router.refresh();
    });
  };

  const outcome = result && !open ? result : null;
  return (
    <>
      <Button size={size} onClick={approve} disabled={disabled} onBlur={() => setConfirm(false)} aria-label={confirm ? (pr ? `Confirm: merge pull request #${pr}` : "Confirm: approve the outputs") : pr ? "Approve and merge" : "Approve outputs"}>
        {pr ? <GitMerge className="size-3.5" aria-hidden="true" /> : <Check className="size-3.5" aria-hidden="true" />}
        {pr ? (pending && confirm ? "Merging…" : confirm ? `Merge #${pr} now` : "Approve and merge") : pending && confirm ? "Approving…" : confirm ? "Approve now" : "Approve outputs"}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button size={size} variant="outline" disabled={disabled}>
            <MessageSquareWarning className="size-3.5" aria-hidden="true" /> Request changes
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Request changes</SheetTitle>
            <SheetDescription>
              Your note goes in the task&apos;s thread{pr ? ` and as a comment on pull request #${pr}` : ""}, and the task goes back to the queue: the next run reads the whole thread{pr ? " and pushes to the same pull request" : ""}. Write it for the model that will act on it.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-4">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">What should change</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={8}
                maxLength={6000}
                disabled={pending}
                placeholder="The toggle has no focus ring; match the one on /settings. Keep the copy as it is."
                className="min-h-32 rounded-md border bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label="Review note"
              />
            </label>
            <div>
              <Button onClick={send} disabled={pending || !note.trim()}>
                {pending ? "Sending…" : "Send back to the queue"}
              </Button>
            </div>
            {result && !result.ok && open && (
              <p role="alert" className="text-xs text-destructive">
                {result.message}
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
      {confirm && !pending && <span className="text-xs text-muted-foreground">{pr ? "Click again to squash-merge; the branch is deleted afterwards." : "Click again to accept the outputs and complete the task."}</span>}
      {outcome && (
        <p role={outcome.ok ? "status" : "alert"} className={outcome.ok ? "basis-full text-xs text-ok" : "basis-full text-xs text-destructive"}>
          {outcome.ok ? (outcome.state === "done" ? (outcome.message ?? "Approved.") : `Sent back; the task is ${outcome.state}.`) : outcome.message}
        </p>
      )}
    </>
  );
}
