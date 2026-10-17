"use client";

import * as React from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />;
}

/**
 * The "Show 3 revoked or expired" disclosure every list uses for its folded-away rows: a quiet text trigger that
 * reads "Show …" closed and "Hide …" open, the content under it. `label` is the noun phrase after the verb.
 */
function Disclosure({ label, children, className, defaultOpen = false }: { label: React.ReactNode; children: React.ReactNode; className?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      <CollapsibleTrigger className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
        {open ? "Hide" : "Show"} {label}
      </CollapsibleTrigger>
      <CollapsibleContent className={cn("mt-2")}>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent, Disclosure };
