import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * The one small label: lanes, labels, tags, codes, the "demo" mark. A hairline border in the tone's color, never a
 * fill, so it reads as metadata next to a status badge (components/ui/status-badge.tsx builds on it). `mono` is for
 * identifiers (lanes, codes, tags); words stay in sans. `asChild` turns it into a link or list item.
 */
const pillVariants = cva("inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded border leading-4 [&>svg]:size-3 [&>svg]:shrink-0", {
  variants: {
    tone: {
      muted: "border-border text-muted-foreground",
      primary: "border-primary/40 text-primary",
      ok: "border-ok/40 text-ok",
      warn: "border-warn/40 text-warn",
      bad: "border-bad/40 text-bad",
    },
    size: {
      sm: "px-1 py-0 text-[10px]",
      md: "px-1.5 py-px text-[11px]",
    },
    mono: {
      true: "font-mono",
      false: "",
    },
  },
  defaultVariants: { tone: "muted", size: "md", mono: false },
});

export type PillTone = NonNullable<VariantProps<typeof pillVariants>["tone"]>;

export function Pill({ className, tone, size, mono, asChild = false, ...props }: React.ComponentProps<"span"> & VariantProps<typeof pillVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return <Comp data-slot="pill" className={cn(pillVariants({ tone, size, mono }), className)} {...props} />;
}

export { pillVariants };
