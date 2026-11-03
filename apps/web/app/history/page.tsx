import type { Metadata } from "next";
import { HISTORY_METADATA, HistoryPage, type HistorySearch } from "@/components/board/history-page";
import { requireSession } from "@/lib/session";

/** The history, the third tab of the signed-in home: every task newest first, paged; filters live in the query string. */

export const metadata: Metadata = HISTORY_METADATA;
export const dynamic = "force-dynamic";

export default async function HistoryRoute({ searchParams }: { searchParams: Promise<HistorySearch> }) {
  await requireSession("/history");
  return <HistoryPage searchParams={searchParams} />;
}
