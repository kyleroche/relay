"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { requeueTaskAction, type TaskActionResult } from "@/app/tasks/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * "Requeue": put the task back in the queue, optionally on another lane or model. A sheet that opens from a button,
 * like the other forms (DESIGN.md, item 7): the lane (the built-in lanes and `any` first, then the lanes other
 * workers on the board serve, fetched once by the page) and the model the lane is asked for. The same core call as
 * `relay_task_requeue`, `POST /api/v1/tasks/{id}/requeue` and `relay task requeue`. Renders into the parent's
 * flex-wrap row beside the review buttons; its outcome takes a full-width line under them.
 */
export function RequeueAction({ taskId, lane, model, state, builtinLanes, servedLanes = [], canWrite, size = "default" }: { taskId: string; lane: string | null; model: string | null; state: string; builtinLanes: readonly string[]; servedLanes?: readonly string[]; canWrite: boolean; size?: "default" | "sm" }) {
  const router = useRouter();
  const [result, setResult] = useState<TaskActionResult | null>(null);
  const [open, setOpen] = useState(false);
  // a task's own lane is always offered, even when no worker lists it any more
  const others = [...new Set([...servedLanes, ...(lane ? [lane] : [])])].filter((l) => !builtinLanes.includes(l));
  const [target, setTarget] = useState<string>(lane ?? builtinLanes[0] ?? "claude");
  const [wanted, setWanted] = useState(model ?? "");
  const [pending, start] = useTransition();

  const send = () => {
    if (pending) return;
    const next = wanted.trim();
    start(async () => {
      const r = await requeueTaskAction(taskId, { ...(target !== lane ? { lane: target } : {}), ...(next !== (model ?? "") ? { model: next || null } : {}) });
      setResult(r);
      if (r.ok) setOpen(false);
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
              . Requeue puts it back in the queue: a failed task is reopened, a hold is lifted, and the next idle worker that serves the lane you pick claims it and starts over from the base branch with the whole thread to read. An open pull request is kept and reused.
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
                    <SelectLabel>Built in (machines running relay work)</SelectLabel>
                    {builtinLanes.map((l) => (
                      <SelectItem key={l} value={l} className="font-mono">
                        {l}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  {others.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Other workers on the board</SelectLabel>
                      {others.map((l) => (
                        <SelectItem key={l} value={l} className="font-mono">
                          {l}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
              {relaning && (
                <span className="text-muted-foreground">
                  Moves the task from {lane ? <code className="font-mono">{lane}</code> : "no lane"} to <code className="font-mono">{target}</code>.
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Model (optional; empty is the lane&apos;s default)</span>
              <Input value={wanted} onChange={(e) => setWanted(e.target.value)} maxLength={128} disabled={pending} placeholder="fable" className="font-mono" aria-label="Model" />
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
          {result.ok ? `Requeued; the task is ${result.state}.` : result.message}
        </p>
      )}
    </>
  );
}
