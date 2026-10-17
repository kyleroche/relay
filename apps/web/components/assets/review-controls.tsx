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
 * Approve or reject, with a note. Approve is irreversible (the task is told), so it takes two steps: the first `a` or
 * click arms it, the second confirms; anything else (blur, Escape) disarms it. `r` moves focus to the note for a
 * rejection; Cmd/Ctrl+Enter in the note submits it. Nothing animates; the page re-renders with the new status.
 */
export function ReviewControls({ asset }: { asset: Asset }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [confirm, setConfirm] = useState(false);
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
      setConfirm(false);
      if (r.ok) {
        setNote("");
        setRejecting(false);
        router.refresh();
      }
    });
  };

  const approve = () => {
    if (pending) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    submit("approved");
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
      if (ev.key === "Escape") {
        setConfirm(false);
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "a") {
        ev.preventDefault();
        approve();
      } else if (ev.key === "r") {
        ev.preventDefault();
        setConfirm(false);
        setRejecting(true);
        setTimeout(() => noteRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit and approve close over the latest note and confirm through state
  }, [reviewable, note, pending, confirm]);

  if (!reviewable && !publishable) {
    return result && !result.ok ? <p className="text-xs text-bad">{result.message}</p> : null;
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-card p-3" aria-live="polite">
      {reviewable && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={approve} onBlur={() => setConfirm(false)} disabled={pending} aria-label={confirm ? "Confirm: approve this asset" : "Approve"}>
              <Check className="size-3.5" aria-hidden="true" /> {pending && confirm ? "Approving…" : confirm ? "Approve now" : "Approve"}
              <Kbd className="ml-1 border-primary-foreground/30 bg-transparent text-primary-foreground/80">a</Kbd>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || (rejecting && !note.trim())}
              onClick={() => {
                setConfirm(false);
                if (!rejecting) {
                  setRejecting(true);
                  setTimeout(() => noteRef.current?.focus(), 0);
                } else submit("rejected");
              }}
            >
              <X className="size-3.5" aria-hidden="true" /> {rejecting ? "Reject with note" : "Reject"}
              {!rejecting && <Kbd className="ml-1 bg-transparent">r</Kbd>}
            </Button>
            {pending && <span className="text-xs text-muted-foreground">saving…</span>}
            {confirm && !pending && <span className="text-xs text-muted-foreground">Once more to approve; the task is told.</span>}
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
            <span className="text-xs">
              <Kbd>⌘/Ctrl</Kbd> + <Kbd>Enter</Kbd> submits
            </span>
          </label>
        </>
      )}
      {publishable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={publish} disabled={pending}>
            <Globe className="size-3.5" aria-hidden="true" /> Publish to a permanent URL
          </Button>
          <span className="text-xs text-muted-foreground">Copies the bytes to the public store. Needs Vercel Blob.</span>
        </div>
      )}
      {result && !result.ok && <p className="text-xs text-bad">{result.message}</p>}
    </div>
  );
}
