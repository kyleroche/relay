"use client";

import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { grantSetAction, type TaskActionResult } from "@/app/tasks/actions";
import { Button } from "@/components/ui/button";

/**
 * "Grant": let this task's runs use one capability set of its project's profile. Two steps, like Release (one click
 * arms it, the second sends), because it hands the task's lane the variables and hosts the set names; the grant covers
 * the task's text as it stands, so an edit of the task voids it. The same core call as `relay task grant`. Renders
 * into its row; the outcome takes a full-width line under it.
 */
export function GrantSetAction({ taskId, set, canWrite }: { taskId: string; set: string; canWrite: boolean }) {
  const router = useRouter();
  const [result, setResult] = useState<TaskActionResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();

  const grant = () => {
    if (pending) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    start(async () => {
      const r = await grantSetAction(taskId, set);
      setResult(r);
      setConfirm(false);
      router.refresh();
    });
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={grant} disabled={!canWrite || pending} onBlur={() => setConfirm(false)} aria-label={confirm ? `Confirm: grant ${set} to this task` : `Grant ${set}`}>
        <KeyRound className="size-3.5" aria-hidden="true" />
        {pending ? "Granting…" : confirm ? "Grant now" : "Grant"}
      </Button>
      {confirm && !pending && <span className="text-xs text-muted-foreground">Click again: this task&apos;s runs may then use the set&apos;s variables and reach its hosts.</span>}
      {result && (
        <p role={result.ok ? "status" : "alert"} className={result.ok ? "basis-full text-xs text-ok" : "basis-full text-xs text-destructive"}>
          {result.message}
        </p>
      )}
    </>
  );
}
