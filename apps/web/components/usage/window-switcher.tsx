"use client";

import { useRouter } from "next/navigation";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { UsageWindow } from "@/lib/types";

/** The usage window as a toggle group; the window lives in the URL, so a choice navigates. */
export function WindowSwitcher({ value, options }: { value: UsageWindow; options: Array<{ id: UsageWindow; label: string; href: string }> }) {
  const router = useRouter();
  return (
    <ToggleGroup type="single" size="sm" value={value} aria-label="Window" onValueChange={(v) => {
      const next = options.find((o) => o.id === v);
      if (next) router.push(next.href);
    }}>
      {options.map((o) => (
        <ToggleGroupItem key={o.id} value={o.id}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
