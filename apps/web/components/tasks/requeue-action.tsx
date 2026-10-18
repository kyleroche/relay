"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { requeueTaskAction, type TaskActionResult } from "@/app/tasks/actions";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * "Requeue": put the task back in the queue, optionally on another lane. A sheet that opens from a button, like the
 * other forms (DESIGN.md, item 7): the lane (worker lanes first, the cloud lanes under their own heading because
 * nothing dispatches them until the operator wires them) and an optional reason. The same core call as
 * `relay_task_requeue`, `POST /api/v1/tasks/{id}/requeue` and `relay task requeue`. Renders into the parent's
 * flex-wrap row beside the review buttons; its outcome takes a full-width line under them.
 */
export function RequeueAction({ taskId, lane, state, workerLanes, cloudLanes, canWrite, size = "default" }: { taskId: string; lane: string | null; state: string; workerLanes: readonly string[]; cloudLanes: readonly string[]; canWrite: boolean; size?: "default" | "sm" }) {
  const router = useRouter();
  const [result, setResult] = useState<TaskActionResult | null>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string>(lane && [...workerLanes, ...cloudLanes].includes(lane) ? lane : workerLanes[0] ?? "claude");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  const send = () => {
    if (pending) return;
    start(async () => {
      const r = await requeueTaskAction(taskId, { lane: target !== lane ? target : null, reason });
      setResult(r);
      if (r.ok) {
        setReason("");
        setOpen(false);
      }
      router.refresh();
    });
  };

  const relaning = target !== lane;
  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button size={size} variant="outline" disabled={!canWrite || pending}>
            <RotateCcw className="size-3.5" aria-hidden="true" /> Requeue
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Requeue</SheetTitle>
            <SheetDescription>
              The task is {state}
              {lane ? (
                <>
                  {" "}
                  on the <span className="font-mono">{lane}</span> lane
                </>
              ) : null}
              . Requeue puts it back in the queue: a live worker claim is released, the <code className="font-mono">agent:*</code> label on the issue follows the lane you pick, and the next idle worker that serves that lane claims it and starts over from the base branch. An open PR is kept and reused.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-4">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Lane</span>
              <Select value={target} onValueChange={setTarget} disabled={pending}>
                <SelectTrigger aria-label="Lane" className="w-full font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Workers (machines running relay work)</SelectLabel>
                    {workerLanes.map((l) => (
                      <SelectItem key={l} value={l} className="font-mono">
                        {l}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  {cloudLanes.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Cloud (dispatches only once wired)</SelectLabel>
                      {cloudLanes.map((l) => (
                        <SelectItem key={l} value={l} className="font-mono">
                          {l}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
              {relaning && <span className="text-muted-foreground">Moves the issue&apos;s label from {lane ? <code className="font-mono">agent:{lane}</code> : "none"} to <code className="font-mono">agent:{target}</code>.</span>}
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Reason (optional, goes in the feed)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={2000}
                disabled={pending}
                placeholder="The cloud lane is not wired; run it on a worker."
                className="min-h-16 rounded-md border bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label="Reason"
              />
            </label>
            <div>
              <Button onClick={send} disabled={pending}>
                {pending ? "Requeuing…" : relaning ? `Requeue on ${target}` : "Requeue"}
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
          {result.ok ? `Requeued; the task is ${result.state}.${result.message ? ` ${result.message}` : ""}` : result.message}
        </p>
      )}
    </>
  );
}
