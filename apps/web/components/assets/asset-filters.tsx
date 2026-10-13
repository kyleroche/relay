"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ASSET_KINDS, ASSET_STATUSES } from "@/lib/types";

export interface AssetFilterValues {
  project?: string;
  status?: string;
  kind?: string;
}

/** Filters live in the URL so a filtered gallery is a link someone can send. */
export function AssetFilters({ filters, projects }: { filters: AssetFilterValues; projects: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const setFilter = useCallback(
    (key: keyof AssetFilterValues, value: string) => {
      const params = new URLSearchParams();
      const next = { ...filters, [key]: value === "all" ? undefined : value };
      for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );
  const any = Boolean(filters.project || filters.status || filters.kind);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSelect label="Project" value={filters.project} onChange={(v) => setFilter("project", v)} options={projects.map((p) => [p, p])} />
      <FilterSelect label="Status" value={filters.status} onChange={(v) => setFilter("status", v)} options={ASSET_STATUSES.map((s) => [s, s === "pending" ? "needs review" : s])} />
      <FilterSelect label="Kind" value={filters.kind} onChange={(v) => setFilter("kind", v)} options={ASSET_KINDS.map((k) => [k, k])} />
      {any && (
        <Button variant="ghost" size="sm" onClick={() => router.push(pathname)} className="h-8 text-muted-foreground">
          Clear
        </Button>
      )}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string | undefined; onChange: (v: string) => void; options: Array<[string, string]> }) {
  const current = value ? (options.find(([v]) => v === value)?.[1] ?? value) : `All ${label.toLowerCase()}s`;
  return (
    <Select value={value ?? "all"} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} className="h-8 min-w-28 text-xs">
        <SelectValue placeholder={label}>{current}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All {label.toLowerCase()}s</SelectItem>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
