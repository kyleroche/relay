/** The compact scope strip every Access list shares. */

/** Scopes as one muted mono string: "tasks:read · tasks:write · events:write". */
export function Scopes({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return null;
  return <span className="font-mono text-[11px] text-muted-foreground">{scopes.join(" · ")}</span>;
}
