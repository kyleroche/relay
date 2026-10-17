import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** A key as the keyboard shows it: a tiny mono box. Inside a filled button, pass a class that drops the background. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return <kbd className={cn("inline-block rounded border bg-muted px-1 font-mono text-[10px] leading-4 text-muted-foreground", className)} {...props} />;
}
