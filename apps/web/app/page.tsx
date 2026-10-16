import type { Metadata } from "next";
import { FEED_METADATA, FeedPage, type Search } from "@/components/feed/feed-page";
import { Landing, LANDING_METADATA } from "@/components/landing/landing";
import { dataMode } from "@/lib/data";
import { homeView } from "@/lib/negotiate";
import { getSession } from "@/lib/session";

/**
 * Two pages share this path. A signed-in viewer (and everyone in mock mode, which has no sign-in) gets the feed; an
 * anonymous visitor gets the public landing, server-rendered with no redirect, so people and agents arriving at the
 * root see what relay is. proxy.ts makes the same call for the Markdown mirror (lib/negotiate.ts `homeDecision`).
 */

export const dynamic = "force-dynamic";

async function view() {
  const session = await getSession();
  return homeView({ signedIn: session !== null, mock: dataMode() === "mock" });
}

export async function generateMetadata(): Promise<Metadata> {
  return (await view()) === "feed" ? FEED_METADATA : LANDING_METADATA;
}

export default async function HomePage({ searchParams }: { searchParams: Promise<Search> }) {
  if ((await view()) === "landing") return <Landing />;
  return <FeedPage searchParams={searchParams} />;
}
