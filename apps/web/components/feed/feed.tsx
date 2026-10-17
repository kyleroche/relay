"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EventRow } from "@/components/feed/event-row";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EVENT_KIND_LIST, kindInfo } from "@/lib/events";
import { dayKeyIn, dayLabelIn } from "@/lib/tz";
import type { FeedEvent } from "@/lib/types";

export interface FeedFilters {
  project?: string;
  lane?: string;
  actor?: string;
  kind?: string;
}

const LANES = ["claude", "codex", "grok"];

export function Feed({
  events: initial,
  projects,
  actors,
  filters,
  tz,
  live = true,
}: {
  events: FeedEvent[];
  projects: string[];
  actors: string[];
  filters: FeedFilters;
  tz: string;
  live?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [events, setEvents] = useState(initial);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Server props win when filters change.
  useEffect(() => {
    setEvents(initial);
    setSelected(null);
  }, [initial]);

  const setFilter = useCallback(
    (key: keyof FeedFilters, value: string) => {
      const params = new URLSearchParams();
      const next = { ...filters, [key]: value === "all" ? undefined : value };
      for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return events;
    return events.filter((e) =>
      [e.summary, e.actor, e.project ?? "", e.kind, e.model ?? "", e.issue ? `#${e.issue}` : "", e.pr ? `#${e.pr}` : ""]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [events, q]);

  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; items: FeedEvent[] }> = [];
    for (const e of visible) {
      const key = dayKeyIn(e.ts, tz);
      const last = out.at(-1);
      if (last && last.key === key) last.items.push(e);
      else out.push({ key, label: dayLabelIn(e.ts, tz), items: [e] });
    }
    return out;
  }, [visible, tz]);

  // Live: pull anything newer than what we have, every 30s and when the tab returns.
  useEffect(() => {
    if (!live) return;
    let alive = true;
    const tick = async () => {
      const newest = events[0]?.ts;
      const params = new URLSearchParams();
      if (newest) params.set("after", newest);
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      try {
        const res = await fetch(`/api/feed?${params}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { events: FeedEvent[] };
        if (!alive || data.events.length === 0) return;
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          const add = data.events.filter((e) => !seen.has(e.id));
          if (add.length === 0) return prev;
          setFresh(new Set(add.map((e) => e.id)));
          return [...add, ...prev];
        });
      } catch {
        // offline; try again next tick
      }
    };
    const id = setInterval(tick, 30_000);
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [events, filters, live]);

  // Keyboard: j/k move, Enter opens, / searches, Esc clears.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (ev.key === "Escape") {
        if (typing) {
          (target as HTMLInputElement).blur();
          if (q) setQ("");
        } else setSelected(null);
        return;
      }
      if (typing) return;
      if (ev.key === "/") {
        ev.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (ev.key === "j" || ev.key === "k") {
        ev.preventDefault();
        if (visible.length === 0) return;
        const idx = selected == null ? -1 : visible.findIndex((e) => e.id === selected);
        const nextIdx = ev.key === "j" ? Math.min(visible.length - 1, idx + 1) : Math.max(0, idx - 1);
        const next = visible[nextIdx];
        if (!next) return;
        setSelected(next.id);
        document.getElementById(`event-${next.id}`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (ev.key === "Enter" && selected != null) {
        const e = visible.find((x) => x.id === selected);
        if (e?.url) window.open(e.url, "_blank", "noopener");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [q, selected, visible]);

  const anyFilter = Boolean(filters.project || filters.lane || filters.actor || filters.kind);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search summary, actor, #issue…"
            aria-label="Search events"
            className="h-8 pl-8 pr-8 text-sm"
          />
          {q ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQ("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            <Kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 sm:block">/</Kbd>
          )}
        </div>
        <FilterSelect label="Project" value={filters.project} onChange={(v) => setFilter("project", v)} options={projects.map((p) => [p, p])} />
        <FilterSelect label="Lane" value={filters.lane} onChange={(v) => setFilter("lane", v)} options={LANES.map((l) => [l, l])} />
        <FilterSelect label="Actor" value={filters.actor} onChange={(v) => setFilter("actor", v)} options={actors.map((a) => [a, a])} />
        <FilterSelect
          label="Kind"
          value={filters.kind}
          onChange={(v) => setFilter("kind", v)}
          options={EVENT_KIND_LIST.map((k) => [k, kindInfo(k).label])}
        />
        {anyFilter && (
          <Button variant="ghost" size="sm" onClick={() => router.push(pathname)} className="h-8 text-muted-foreground">
            Clear
          </Button>
        )}
      </div>

      {groups.length === 0 ? (
        <FeedEmpty filtered={anyFilter || q.length > 0} />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section key={g.key} aria-labelledby={`day-${g.key}`}>
              <h2 id={`day-${g.key}`} className="sticky top-14 z-10 -mx-2 mb-1 bg-background/95 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur sm:top-14">
                {g.label}
                <span className="ml-2 font-mono text-[10px] tabular-nums text-muted-foreground/70">{g.items.length}</span>
              </h2>
              <ul className="-mx-2 divide-y divide-border/60">
                {g.items.map((e) => (
                  <EventRow key={e.id} event={e} tz={tz} selected={selected === e.id} isNew={fresh.has(e.id)} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        <Kbd>j</Kbd> / <Kbd>k</Kbd> to move, <Kbd>Enter</Kbd> to open, <Kbd>/</Kbd> to search.
        {live && " Refreshes every 30 seconds."}
      </p>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  const current = value ? (options.find(([v]) => v === value)?.[1] ?? value) : `All ${label.toLowerCase()}s`;
  return (
    <Select value={value ?? "all"} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} className="h-8 min-w-28 text-xs">
        {/* Children render on the server; Radix only resolves item text after hydration. */}
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

function FeedEmpty({ filtered }: { filtered: boolean }) {
  if (filtered) return <EmptyState title="Nothing matches these filters">Widen the filters or clear the search. Events are never deleted, so what you saw before is still here.</EmptyState>;
  return (
    <EmptyState
      title="No events yet"
      command={`GitHub  → POST /api/webhooks/github   (X-Hub-Signature-256, GITHUB_WEBHOOK_SECRET)
Vercel  → POST /api/webhooks/vercel   (x-vercel-signature, VERCEL_WEBHOOK_SECRET)
Workers → relay work … writes run.* and step.usage through @relay/core`}
    >
      Events arrive three ways. GitHub sends issues, labels, pull requests, reviews and workflow runs to the webhook. Vercel sends deployments. Workers write run.* and step.usage rows as they execute a lane.
    </EmptyState>
  );
}
