"use client";

import { BookOpenCheck, Check, GitMerge, ListChecks, MessageSquareWarning } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveTaskAction, requestChangesAction, type TaskActionResult } from "@/app/tasks/actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { approveCopy, type ReviewKind } from "@/lib/review";
import { taskPagePath } from "@/lib/task-path";

const ICON = { pr: GitMerge, plan: ListChecks, report: BookOpenCheck, outputs: Check } as const;

/**
 * The two decisions on a task in review. Approve does what `kind` says (lib/review.ts): merges the pull request the
 * task waits on, opens the tasks of the plan it proposed, marks its report as read, or accepts the outputs attached
 * to its thread; always in two clicks, the first arms it and the second sends. Request changes opens a sheet for the
 * note, like the Access page's forms (DESIGN.md, item 7). Both call the same core functions the API and the MCP tools
 * use. Renders into the parent's flex-wrap row: the buttons inline, the outcome on a full-width line under them.
 */
export function ReviewActions({ taskId, pr, kind, canWrite, size = "default" }: { taskId: string; pr: number | null; kind: ReviewKind; canWrite: boolean; size?: "default" | "sm" }) {
  const router = useRouter();
  const [result, setResult] = useState<TaskActionResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const disabled = !canWrite || pending;
  const copy = approveCopy(kind, pr);
  const Icon = ICON[kind];

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
      <Button size={size} onClick={approve} disabled={disabled} onBlur={() => setConfirm(false)} aria-label={confirm ? `Confirm: ${copy.armed}` : copy.label}>
        <Icon className="size-3.5" aria-hidden="true" />
        {pending && confirm ? copy.pending : confirm ? copy.armed : copy.label}
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
            <SheetDescription>{copy.sendBack} Write it for the model that will act on it.</SheetDescription>
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
                placeholder={kind === "plan" ? "Split the migration from the API change, and put the importer on codex." : "The toggle has no focus ring; match the one on /settings. Keep the copy as it is."}
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
      {confirm && !pending && <span className="text-xs text-muted-foreground">{copy.hint}</span>}
      {outcome && (
        <p role={outcome.ok ? "status" : "alert"} className={outcome.ok ? "basis-full text-xs text-ok" : "basis-full text-xs text-destructive"}>
          {outcome.ok ? (outcome.state === "done" ? (outcome.message ?? copy.done) : `Sent back; the task is ${outcome.state}.`) : outcome.message}
          {outcome.ok &&
            outcome.opened?.map((id) => (
              <span key={id}>
                {" "}
                <Link href={taskPagePath(id)} className="font-mono underline underline-offset-2">
                  {id}
                </Link>
              </span>
            ))}
        </p>
      )}
    </>
  );
}
