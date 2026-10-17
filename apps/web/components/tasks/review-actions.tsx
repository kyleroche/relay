"use client";

import { GitMerge, MessageSquareWarning } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveTaskAction, requestChangesAction, type TaskActionResult } from "@/app/tasks/actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * The two decisions on a task in review. Approve merges on the spot (one click, one confirmation state); Request
 * changes opens a sheet for the note, like the Access page's forms (DESIGN.md, item 7). Both call the same core
 * functions the API and the MCP tools use, so the feed row is the same whoever decided.
 */
export function ReviewActions({ taskId, pr, canWrite }: { taskId: string; pr: number | null; canWrite: boolean }) {
  const router = useRouter();
  const [result, setResult] = useState<TaskActionResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const disabled = !canWrite || pending || pr == null;

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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={approve} disabled={disabled} onBlur={() => setConfirm(false)} aria-label={confirm ? `Confirm: merge pull request #${pr}` : "Approve and merge"}>
          <GitMerge className="size-3.5" aria-hidden="true" />
          {pending && confirm ? "Merging…" : confirm ? `Merge #${pr} now` : "Approve and merge"}
        </Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" disabled={disabled}>
              <MessageSquareWarning className="size-3.5" aria-hidden="true" /> Request changes
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
            <SheetHeader>
              <SheetTitle>Request changes</SheetTitle>
              <SheetDescription>
                Your note is posted on pull request #{pr} as <code className="font-mono">relay: changes requested by you</code> and handed to the next run as review feedback. The task goes back to the queue; the same branch and PR are reused. Write it for the model that will act on it.
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-3 px-4">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">What should change</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={8}
                  maxLength={10_000}
                  disabled={pending}
                  placeholder="The toggle has no focus ring; match the one on /settings. Keep the copy as it is."
                  className="min-h-32 rounded-md border bg-background px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
        {confirm && !pending && <span className="text-xs text-muted-foreground">Click again to squash-merge; the branch is deleted afterwards.</span>}
      </div>
      {result && !open && (
        <p role={result.ok ? "status" : "alert"} className={result.ok ? "text-xs text-ok" : "text-xs text-destructive"}>
          {result.ok ? (result.state === "done" ? "Merged. GitHub's own pr.merged will confirm it in the feed." : `Sent back; the task is ${result.state}.`) : result.message}
        </p>
      )}
    </div>
  );
}
