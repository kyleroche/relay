import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "bad" | "warn" | "primary" | "muted";

const TONE: Record<Tone, string> = {
  bad: "border-bad/40 bg-bad/5",
  warn: "border-warn/40 bg-warn/5",
  primary: "border-primary/40 bg-primary/5",
  muted: "border-border bg-card",
};

/**
 * The one banner style (the sign-in page's): a bordered, lightly tinted paragraph. `bad` is an alert, everything else
 * a status. Errors appear once per page, in one of these.
 */
export function Alert({ tone = "muted", role, children, className }: { tone?: Tone; role?: "alert" | "status"; children: ReactNode; className?: string }) {
  return (
    <p role={role ?? (tone === "bad" ? "alert" : "status")} className={cn("rounded-md border p-3 text-sm", TONE[tone], className)}>
      {children}
    </p>
  );
}
