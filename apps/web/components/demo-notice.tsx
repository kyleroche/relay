import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The one line a page shows in mock mode (no RELAY_DATA=db or DATABASE_URL): the page still renders, its actions are
 * disabled, and this says why. Every page uses this same sentence.
 */
export function DemoNotice({ className }: { className?: string }) {
  return (
    <p className={cn("rounded-md border border-dashed p-3 text-xs text-muted-foreground", className)}>
      This relay runs on demo data, so nothing here can be changed.{" "}
      <Link href="/docs/hosting" className="underline underline-offset-2 hover:text-foreground">
        Hosting
      </Link>{" "}
      explains how to give it a database.
    </p>
  );
}
