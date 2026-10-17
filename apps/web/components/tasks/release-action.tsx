"use client";

import { ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { releaseTaskAction, type TaskActionResult } from "@/app/tasks/actions";
import { Button } from "@/components/ui/button";

/**
 * "Release": lift the injection gate's hold on a task. Two steps, like Approve (one click arms it, the second sends),
 * because the person is vouching for text the gate flagged: the next worker grades it again and runs it if it passes.
 * The same core call as `relay_task_release`, `POST /api/v1/tasks/{id}/release` and `relay task release`. Renders into
 * the Held card's flex-wrap row beside Requeue; the outcome takes a full-width line under them.
 */
export function ReleaseAction({ taskId, canWrite }: { taskId: string; canWrite: boolean }) {
  const router = useRouter();
  const [result, setResult] = useState<TaskActionResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();

  const release = () => {
    if (pending) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    start(async () => {
      const r = await releaseTaskAction(taskId);
      setResult(r);
      setConfirm(false);
      router.refresh();
    });
  };

  return (
    <>
      <Button variant="outline" onClick={release} disabled={!canWrite || pending} onBlur={() => setConfirm(false)} aria-label={confirm ? "Confirm: release this task to the queue" : "Release"}>
        <ShieldCheck className="size-3.5" aria-hidden="true" />
        {pending ? "Releasing…" : confirm ? "Release now" : "Release"}
      </Button>
      {confirm && !pending && <span className="text-xs text-muted-foreground">Click again: the task goes back to the queue and the next worker grades it again before running.</span>}
      {result && (
        <p role={result.ok ? "status" : "alert"} className={result.ok ? "basis-full text-xs text-ok" : "basis-full text-xs text-destructive"}>
          {result.ok ? `Released; the task is ${result.state}.` : result.message}
        </p>
      )}
    </>
  );
}
