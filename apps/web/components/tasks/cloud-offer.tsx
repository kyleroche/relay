"use client";

import { CloudUpload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import { approveCloudRunAction, type TaskActionResult } from "@/app/tasks/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { CloudApprovedView, CloudView } from "@/lib/cloud/view";
import { fmtDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** "Keep waiting" is this viewer's own: kept in the browser, so the board's refresh does not open the offer again. */
const KEPT = "relay:cloud-kept";
const key = (taskId: string): string => `relay.cloud.keep-waiting.${taskId}`;
function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(KEPT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(KEPT, onChange);
  };
}
function kept(taskId: string): boolean {
  try {
    return window.localStorage.getItem(key(taskId)) === "1";
  } catch {
    return false;
  }
}
function keep(taskId: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key(taskId), "1");
    else window.localStorage.removeItem(key(taskId));
  } catch {
    // a browser that keeps nothing shows the offer again on the next render; nothing else changes
  }
  window.dispatchEvent(new Event(KEPT));
}

/** Where a run a person approved stands, in one sentence. */
function approvedLine(a: CloudApprovedView): string {
  const cap = `up to ${usd(a.capUsd)}`;
  switch (a.status) {
    case "pending":
      return a.why ? `Cloud run approved, ${cap}. The last start did not come up (${a.why}); the site tries again shortly.` : `Cloud run approved, ${cap}. A sandbox starts shortly, unless one of your workers takes the task first.`;
    case "starting":
      return `Cloud run approved, ${cap}. A sandbox is coming up and will claim the task.`;
    case "ended":
      return `The approved cloud run (${cap}) started, and the task is in the queue again: the run stopped before it finished. Nothing more starts by itself.`;
    case "gave-up":
      return `Cloud run approved, ${cap}, but no sandbox came up${a.why ? `: ${a.why}` : ""}. Nothing was spent on the model; nothing more starts by itself.`;
  }
}

/**
 * A queued task nobody's machine can take now: "Waiting for a worker", with two choices. "Run in cloud" opens a sheet
 * (the cap is something a person types, DESIGN.md item 7) and approving there is the owner's yes to the spend;
 * "Keep waiting" does nothing but fold the offer away for this viewer, because waiting for one of their own machines
 * is the default and needs no action. When a run was already approved, the line says where it stands instead.
 * Renders into the parent's block: the same component on a board card (`sm`) and on the task page.
 */
export function CloudOffer({ taskId, view, canWrite, size = "default", className }: { taskId: string; view: CloudView; canWrite: boolean; size?: "default" | "sm"; className?: string }) {
  const router = useRouter();
  const folded = useSyncExternalStore(
    subscribe,
    () => kept(taskId),
    () => false,
  );
  const [open, setOpen] = useState(false);
  const [cap, setCap] = useState(view.offer ? view.offer.capUsd.toFixed(2) : "");
  const [result, setResult] = useState<TaskActionResult | null>(null);
  const [pending, start] = useTransition();
  const offer = view.offer;
  const amount = Number(cap);
  const valid = !!offer && Number.isFinite(amount) && amount > 0 && amount <= offer.maxCapUsd;

  const approve = () => {
    if (pending || !valid) return;
    start(async () => {
      const r = await approveCloudRunAction(taskId, amount);
      setResult(r);
      if (r.ok) setOpen(false);
      router.refresh();
    });
  };

  return (
    <div className={cn("flex flex-col gap-1.5 text-xs", className)}>
      {view.approved && (
        <p className={view.approved.status === "gave-up" ? "text-warn" : "text-muted-foreground"}>
          <CloudUpload className="mr-1 inline size-3.5 align-text-bottom" aria-hidden="true" />
          {approvedLine(view.approved)}
        </p>
      )}
      {offer && folded && (
        <p className="text-muted-foreground">
          Waiting for one of your workers.{" "}
          <button type="button" onClick={() => keep(taskId, false)} className="underline underline-offset-2 hover:text-foreground">
            Other options
          </button>
        </p>
      )}
      {offer && !folded && (
        <>
          <p className="text-muted-foreground">
            Waiting for a worker for <span className="font-mono">{fmtDuration(Math.floor(offer.waitedMs / 60_000) * 60_000)}</span>: none that is online serves this lane.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                {/* the one button whose label is a sentence: it wraps inside a narrow card instead of running out of it */}
                <Button size={size} variant="outline" disabled={!canWrite || pending} className="h-auto min-h-8 max-w-full shrink justify-start whitespace-normal py-1 text-left">
                  <CloudUpload className="size-3.5" aria-hidden="true" />
                  <span>
                    Run in cloud ({offer.estimateUsd === null ? "no history yet" : `about ${usd(offer.estimateUsd)}`}, cap {usd(offer.capUsd)})
                  </span>
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
                <SheetHeader>
                  <SheetTitle>Run in a paid sandbox</SheetTitle>
                  <SheetDescription>
                    Approving starts one Vercel Sandbox that runs this task once on paid credits through the model gateway, opens its pull request and holds it for your review like any other run. It stops at the cap. Nothing is spent unless you approve here; if one of your own workers comes online and takes the task first, nothing is started. Closing this keeps the task waiting for your machines, which costs nothing.
                  </SheetDescription>
                </SheetHeader>
                <div className="flex flex-col gap-3 px-4">
                  <p className="text-xs text-muted-foreground">
                    {offer.estimateUsd === null ? "No history yet: fewer than three past runs of this project to estimate from." : `Past runs of this project on the claude lane cost about ${usd(offer.estimateUsd)} (the median).`}
                  </p>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">Cap, in US dollars (at most {usd(offer.maxCapUsd)} on this deployment)</span>
                    <Input type="number" inputMode="decimal" min={0.01} max={offer.maxCapUsd} step={0.01} value={cap} onChange={(e) => setCap(e.target.value)} disabled={pending} className="w-32 font-mono" aria-label="Cap in US dollars" aria-invalid={!valid} />
                    <span className="text-muted-foreground">A run that reaches its cap stops there, and what it spent is spent. The approval is for the task&apos;s text as it stands: an edit of the task voids it.</span>
                  </label>
                  <div>
                    <Button onClick={approve} disabled={pending || !valid}>
                      {pending ? "Approving…" : valid ? `Approve up to ${usd(amount)}` : "Approve"}
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
            <Button size={size} variant="ghost" onClick={() => keep(taskId, true)} disabled={pending}>
              Keep waiting
            </Button>
          </div>
        </>
      )}
      {result && !open && (
        <p role={result.ok ? "status" : "alert"} className={result.ok ? "text-ok" : "text-destructive"}>
          {result.message}
        </p>
      )}
    </div>
  );
}
