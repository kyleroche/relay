"use client";

import { XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { closeTaskAction, type TaskActionResult } from "@/app/tasks/actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * "Close": finish a task without a merge. A sheet that opens from a button, like Requeue (DESIGN.md, item 7): what
 * closing does, an optional reason that goes on the issue and in the feed, and the one button that does it. The same
 * core call as `relay_task_close`, `POST /api/v1/tasks/{id}/close` and `relay task close`. Renders into the parent's
 * flex-wrap row beside Requeue; its outcome takes a full-width line under them.
 */
export function CloseAction({ taskId, state, pr, canWrite, size = "default" }: { taskId: string; state: string; pr: number | null; canWrite: boolean; size?: "default" | "sm" }) {
  const router = useRouter();
  const [result, setResult] = useState<TaskActionResult | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  const send = () => {
    if (pending) return;
    start(async () => {
      const r = await closeTaskAction(taskId, reason);
      setResult(r);
      if (r.ok) {
        setReason("");
        setOpen(false);
      }
      router.refresh();
    });
  };

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button size={size} variant="outline" disabled={!canWrite || pending}>
            <XCircle className="size-3.5" aria-hidden="true" /> Close
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Close without a merge</SheetTitle>
            <SheetDescription>
              The task is {state}. Close finishes it: the issue is closed on GitHub as not planned with your reason as a comment{pr ? `, PR #${pr} is closed unmerged` : ""}, a worker that holds it is told to stop, and the task moves to Done. Reopening the issue on GitHub is the way to start it again.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-4">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Reason (optional, goes on the issue and in the feed)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={2000}
                disabled={pending}
                placeholder="Opened against a spec the repo does not match."
                className="min-h-16 rounded-md border bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label="Reason"
              />
            </label>
            <div>
              <Button onClick={send} disabled={pending} variant="destructive">
                {pending ? "Closing…" : "Close task"}
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
      {result && !open && (
        <p role={result.ok ? "status" : "alert"} className={result.ok ? "basis-full text-xs text-ok" : "basis-full text-xs text-destructive"}>
          {result.ok ? `Closed; the task is ${result.state}.${result.message ? ` ${result.message}` : ""}` : result.message}
        </p>
      )}
    </>
  );
}
