import type { Metadata } from "next";
import Link from "next/link";
import { FlowView } from "@/components/flow/flow-view";
import { getFlow } from "@/lib/data";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Flow",
  description: "What is moving through relay right now: projects feeding the queue, workers on their lanes, pull requests waiting on previews and decisions.",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

/**
 * /flow: the transit map of everything in motion (components/flow/pipeline-map.tsx). The first scene is rendered on
 * the server so the page has data at first paint; the map then polls /api/flow every 5 s. DESIGN.md, "Visuals".
 */
export default async function FlowPage() {
  await requireSession("/flow");
  const initial = await getFlow();
  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">What is moving</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Lanes are lines, states are stations, tasks are the trains. Only what is in motion is drawn.{" "}
          <Link href="/docs/workers" className="text-primary underline underline-offset-4">
            How it works
          </Link>
        </p>
      </section>
      <section aria-label="Flow map">
        <FlowView initial={initial} />
      </section>
    </>
  );
}
