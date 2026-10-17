import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The small pieces every Access list shares: a quiet tag and a compact scope strip. */

export function Tag({ children, tone = "muted", title }: { children: ReactNode; tone?: "muted" | "warn" | "primary" | "ok"; title?: string }) {
  const cls = tone === "warn" ? "border-warn/50 text-warn" : tone === "primary" ? "border-primary/50 text-primary" : tone === "ok" ? "border-ok/50 text-ok" : "border-border text-muted-foreground";
  return (
    <span title={title} className={cn("inline-flex items-center rounded border px-1.5 py-px font-mono text-[11px] leading-4", cls)}>
      {children}
    </span>
  );
}

/** Scopes as one muted mono string: "tasks:read · tasks:write · events:write". */
export function Scopes({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return null;
  return <span className="font-mono text-[11px] text-muted-foreground">{scopes.join(" · ")}</span>;
}
