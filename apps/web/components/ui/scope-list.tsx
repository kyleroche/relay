import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** One scope as a code chip: "tasks:write". */
export function ScopeCode({ className, ...props }: ComponentProps<"code">) {
  return <code className={cn("shrink-0 rounded bg-muted px-1 font-mono text-[11px] leading-5", className)} {...props} />;
}

type ScopeItem = string | { scope: string; description: string };

/**
 * Scopes, the one way: code chips in a row when they are only names (Access rows), one per line with its description
 * when the reader has to decide (activate, authorize, the scope picker's labels use ScopeCode directly).
 */
export function ScopeList({ scopes, className }: { scopes: readonly ScopeItem[]; className?: string }) {
  if (scopes.length === 0) return null;
  const described = scopes.some((s) => typeof s !== "string");
  if (described) {
    return (
      <ul className={cn("flex flex-col gap-1.5 text-sm", className)} aria-label="Scopes">
        {scopes.map((s) => {
          const scope = typeof s === "string" ? s : s.scope;
          return (
            <li key={scope} className="flex items-start gap-2">
              <ScopeCode>{scope}</ScopeCode>
              {typeof s !== "string" && <span className="text-muted-foreground">{s.description}</span>}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ul className={cn("inline-flex flex-wrap items-center gap-1", className)} aria-label="Scopes">
      {scopes.map((s) => {
        const scope = typeof s === "string" ? s : s.scope;
        return (
          <li key={scope} className="inline-flex">
            <ScopeCode>{scope}</ScopeCode>
          </li>
        );
      })}
    </ul>
  );
}
