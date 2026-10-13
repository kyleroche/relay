import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <section className="py-24 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nothing at this address</h1>
      <p className="mx-auto mt-3 max-w-md text-muted-foreground">
        The feed is at the root, projects under <code>/projects</code>, and the public overview at <code>/info</code>.
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <Button asChild>
          <Link href="/">Open the feed</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/info">What is relay?</Link>
        </Button>
      </div>
    </section>
  );
}
