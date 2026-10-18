import type { Metadata } from "next";
import { FEED_METADATA, FeedPage, type Search } from "@/components/feed/feed-page";
import { requireSession } from "@/lib/session";

/** The feed, the second tab of the signed-in home (the board is at /). Filters live in the query string. */

export const metadata: Metadata = FEED_METADATA;
export const dynamic = "force-dynamic";

export default async function FeedRoute({ searchParams }: { searchParams: Promise<Search> }) {
  await requireSession("/feed");
  return <FeedPage searchParams={searchParams} />;
}
