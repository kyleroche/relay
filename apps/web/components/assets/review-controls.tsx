"use client";

import { Check, Globe, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { publishAction, reviewAction, type ActionResult } from "@/app/assets/[id]/actions";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import type { Asset } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Approve or reject, with a note. Keys: `a` approves, `r` moves focus to the note for a rejection; Cmd/Ctrl+Enter in
 * the note submits the rejection. Nothing animates; the page re-renders with the new status.
 */
export function ReviewControls({ asset }: { asset: Asset }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const reviewable = asset.status === "pending";
  const publishable = asset.status === "approved" && !asset.public_url;

  const submit = (decision: "approved" | "rejected") => {
    if (pending) return;
    start(async () => {
      const r = await reviewAction(asset.id, decision, note);
      setResult(r);
      if (r.ok) {
        setNote("");
        setRejecting(false);
        router.refresh();
      }
    });
  };

  const publish = () => {
    if (pending) return;
    start(async () => {
      const r = await publishAction(asset.id);
      setResult(r);
      if (r.ok) router.refresh();
    });
  };

  useEffect(() => {
    if (!reviewable) return;
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing) {
        if (t === noteRef.current && ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          submit("rejected");
        }
        if (ev.key === "Escape") (t as HTMLElement).blur();
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "a") {
        ev.preventDefault();
        submit("approved");
      } else if (ev.key === "r") {
        ev.preventDefault();
        setRejecting(true);
        setTimeout(() => noteRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit closes over the latest note through state
  }, [reviewable, note, pending]);

  if (!reviewable && !publishable) {
    return result && !result.ok ? <p className="text-xs text-bad">{result.message}</p> : null;
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-card p-3" aria-live="polite">
      {reviewable && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => submit("approved")} disabled={pending} className="gap-1.5">
              <Check className="size-3.5" aria-hidden="true" /> Approve
              <Kbd className="ml-1 border-primary-foreground/30 bg-transparent text-primary-foreground/80">a</Kbd>
            </Button>
            <Button
              size="sm"
              variant={rejecting ? "destructive" : "outline"}
              disabled={pending || (rejecting && !note.trim())}
              onClick={() => {
                if (!rejecting) {
                  setRejecting(true);
                  setTimeout(() => noteRef.current?.focus(), 0);
                } else submit("rejected");
              }}
              className="gap-1.5"
            >
              <X className="size-3.5" aria-hidden="true" /> {rejecting ? "Reject with note" : "Reject"}
              {!rejecting && <Kbd className="ml-1 bg-transparent">r</Kbd>}
            </Button>
            {pending && <span className="text-xs text-muted-foreground">saving…</span>}
          </div>
          <label className={cn("flex flex-col gap-1 text-xs text-muted-foreground", !rejecting && "sr-only")}>
            Why (becomes a project decision, reopens the task)
            <textarea
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="What to change next time. One or two sentences."
              className="w-full rounded-md border bg-background px-2 py-1.5 font-sans text-sm text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <span className="text-[11px]">
              <Kbd>⌘/Ctrl</Kbd> + <Kbd>Enter</Kbd> submits
            </span>
          </label>
        </>
      )}
      {publishable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={publish} disabled={pending} className="gap-1.5">
            <Globe className="size-3.5" aria-hidden="true" /> Publish to a permanent URL
          </Button>
          <span className="text-[11px] text-muted-foreground">Copies the bytes to the public store. Needs Vercel Blob.</span>
        </div>
      )}
      {result && !result.ok && <p className="text-xs text-bad">{result.message}</p>}
    </div>
  );
}
