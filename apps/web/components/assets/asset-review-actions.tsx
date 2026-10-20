"use client";

import { Check, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { reviewAction, type ActionResult } from "@/app/assets/[id]/actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * The two decisions on an asset a task delivered, in the shape of the PR card's `ReviewActions` so a board card reads
 * the same whichever the deliverable is: Approve takes two clicks (the first arms it, blur or Escape disarms), Reject
 * opens a sheet for the note, which a rejection needs (it becomes the review feedback the next run reads and a
 * project decision). The asset page keeps its own `ReviewControls` with the keyboard shortcuts; both call the same
 * server action, so the feed row is the same wherever the decision was made (`asset.reviewed`, which also moves
 * the task: done on approve, queued on reject). Renders into the parent's flex-wrap row; the outcome takes a line.
 */
export function AssetReviewActions({ assetId, version, canWrite, size = "default" }: { assetId: string; version?: number | null; canWrite: boolean; size?: "default" | "sm" }) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const disabled = !canWrite || pending;
  const label = version ? `v${version}` : "the asset";

  const approve = () => {
    if (pending) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    start(async () => {
      const r = await reviewAction(assetId, "approved", "");
      setResult(r);
      setConfirm(false);
      router.refresh();
    });
  };

  const reject = () => {
    if (pending) return;
    start(async () => {
      const r = await reviewAction(assetId, "rejected", note);
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
      <Button size={size} onClick={approve} disabled={disabled} onBlur={() => setConfirm(false)} aria-label={confirm ? `Confirm: approve ${label}` : "Approve the asset"}>
        <Check className="size-3.5" aria-hidden="true" />
        {pending && confirm ? "Approving…" : confirm ? `Approve ${label} now` : "Approve"}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button size={size} variant="outline" disabled={disabled}>
            <X className="size-3.5" aria-hidden="true" /> Reject
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Reject {label}</SheetTitle>
            <SheetDescription>
              Your note is posted on the issue, recorded as a project decision and handed to the next run as review feedback. The task goes back to the queue and the next version lands on the same issue. Write it for the model that will act on it.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-4">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">What to change</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={6}
                maxLength={10_000}
                disabled={pending}
                placeholder="Cut the first two seconds; the logo lands late. Keep the grade."
                className="min-h-28 rounded-md border bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label="Rejection note"
              />
            </label>
            <div>
              <Button onClick={reject} disabled={pending || !note.trim()}>
                {pending ? "Sending…" : "Reject and send back to the queue"}
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
      {confirm && !pending && <span className="text-xs text-muted-foreground">Click again to approve; the issue is closed.</span>}
      {outcome && (
        <p role={outcome.ok ? "status" : "alert"} className={outcome.ok ? "basis-full text-xs text-ok" : "basis-full text-xs text-destructive"}>
          {outcome.ok ? "Recorded; the card moves on the next refresh." : outcome.message}
        </p>
      )}
    </>
  );
}
