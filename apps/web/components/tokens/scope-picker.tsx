"use client";

import { cn } from "@/lib/utils";

export interface ScopeOption {
  name: string;
  description: string;
}

/** The scope checkboxes shared by the invite form and the by-hand token form. Nothing is preselected. */
export function ScopePicker({ scopes, chosen, onToggle, disabled, idPrefix }: { scopes: ScopeOption[]; chosen: Set<string>; onToggle: (scope: string) => void; disabled?: boolean; idPrefix: string }) {
  return (
    <fieldset className="mt-4">
      <legend className="text-xs text-muted-foreground">Scopes</legend>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {scopes.map((s) => (
          <li key={s.name}>
            <label htmlFor={`${idPrefix}-${s.name}`} className={cn("flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors hover:bg-accent/50", chosen.has(s.name) && "border-primary/60 bg-primary/5")}>
              <input id={`${idPrefix}-${s.name}`} type="checkbox" aria-label={s.name} className="mt-0.5 accent-primary" checked={chosen.has(s.name)} onChange={() => onToggle(s.name)} disabled={disabled} />
              <span className="min-w-0">
                <code className="font-mono">{s.name}</code>
                <span className="block text-muted-foreground">{s.description}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** Toggle one scope in a Set state. */
export const toggleIn = (prev: Set<string>, s: string): Set<string> => {
  const next = new Set(prev);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  return next;
};
