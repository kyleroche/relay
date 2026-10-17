"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

const toggleItemVariants = cva(
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground",
  {
    variants: {
      size: {
        default: "h-8 px-3 text-sm",
        sm: "h-6 px-2.5 text-xs",
      },
    },
    defaultVariants: { size: "default" },
  },
);

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleItemVariants>>({ size: "default" });

/** A bordered strip of mutually exclusive choices (the usage window). One item is always on. */
function ToggleGroup({ className, size, children, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & VariantProps<typeof toggleItemVariants>) {
  return (
    <ToggleGroupPrimitive.Root data-slot="toggle-group" className={cn("inline-flex w-fit items-center rounded-md border p-0.5", className)} {...props}>
      <ToggleGroupContext.Provider value={{ size }}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({ className, children, size, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleItemVariants>) {
  const ctx = React.useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item data-slot="toggle-group-item" className={cn(toggleItemVariants({ size: size ?? ctx.size }), className)} {...props}>
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem, toggleItemVariants };
