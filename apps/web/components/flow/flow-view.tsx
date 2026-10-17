"use client";

/**
 * The /flow page's map with its project filter: a row of multi-select pills built from every project the snapshots
 * have mentioned (the initial one and each poll), remembered in localStorage so a busy relay stays narrowed between
 * visits. "All" clears it. The strip on the feed uses PipelineMap directly and takes no filter.
 */
import { useCallback, useEffect, useState } from "react";
import type { FlowProject, FlowSnapshot } from "@/lib/flow";
import { cn } from "@/lib/utils";
import { PipelineMap } from "./pipeline-map";

const STORAGE_KEY = "relay.flow.projects";

function readStored(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function store(next: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // private mode or a full store: the filter still applies for this visit
  }
}

export function FlowView({ initial }: { initial: FlowSnapshot | null }) {
  const [known, setKnown] = useState<FlowProject[]>(initial?.projects ?? []);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    setSelected(readStored());
  }, []);

  const onSnapshot = useCallback((s: FlowSnapshot) => {
    setKnown((cur) => {
      const seen = new Set(cur.map((p) => p.slug));
      const fresh = s.projects.filter((p) => !seen.has(p.slug));
      return fresh.length ? [...cur, ...fresh].sort((a, b) => a.slug.localeCompare(b.slug)) : cur;
    });
  }, []);

  const update = (next: string[]) => {
    setSelected(next);
    store(next);
  };
  const toggle = (slug: string) => update(selected.includes(slug) ? selected.filter((s) => s !== slug) : [...selected, slug]);

  // every project seen plus anything remembered that has not shown up yet, so it can still be unselected
  const pills = [...known.map((p) => p.slug), ...selected.filter((s) => !known.some((p) => p.slug === s))];
  const all = selected.length === 0;

  return (
    <>
      {pills.length > 0 && (
        <div role="group" aria-label="Projects shown" className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="mr-1 text-muted-foreground">Projects</span>
          <button type="button" onClick={() => update([])} aria-pressed={all} className={cn("flow-filter-pill", all && "flow-filter-pill--on")}>
            All
          </button>
          {pills.map((slug) => {
            const on = selected.includes(slug);
            return (
              <button key={slug} type="button" onClick={() => toggle(slug)} aria-pressed={on} className={cn("flow-filter-pill", on && "flow-filter-pill--on")}>
                {slug}
              </button>
            );
          })}
        </div>
      )}
      <PipelineMap initial={initial} projects={selected} onSnapshot={onSnapshot} />
    </>
  );
}
