import type { Metadata } from "next";
import Link from "next/link";
import { PipelineMap } from "@/components/flow/pipeline-map";
import { getFlow } from "@/lib/data";
import { STATIONS } from "@/lib/flow";
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
          Each line is a lane, each stop a station: {STATIONS.join(", ")}. Projects feed the queue from the left, workers sit above Running and tether to the task they are on, a
          failed run drops into the siding. Only tasks in motion are drawn; a merged one leaves at the right edge. Open a pill for the <Link href="/tasks" className="text-primary underline underline-offset-4">task</Link>.
        </p>
      </section>
      <section aria-label="Flow map" className="rounded-lg border bg-card px-3 py-3 sm:px-5 sm:py-4">
        <PipelineMap initial={initial} />
      </section>
    </>
  );
}
