import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BOARD_METADATA, BoardPage } from "@/components/board/board-page";
import { Landing, LANDING_METADATA } from "@/components/landing/landing";
import { dataMode } from "@/lib/data";
import { homeView } from "@/lib/negotiate";
import { getSession } from "@/lib/session";

/**
 * Two pages share this path. A signed-in viewer (and everyone in mock mode, which has no sign-in) gets the board; an
 * anonymous visitor gets the public landing, server-rendered with no redirect, so people and agents arriving at the
 * root see what relay is. proxy.ts makes the same call for the Markdown mirror (lib/negotiate.ts `homeDecision`).
 * The feed, which lived here before the board, is at /feed; a filter link to the old address lands there.
 */

export const dynamic = "force-dynamic";

const FEED_FILTERS = ["project", "lane", "actor", "kind"] as const;

async function view() {
  const session = await getSession();
  return homeView({ signedIn: session !== null, mock: dataMode() === "mock" });
}

export async function generateMetadata(): Promise<Metadata> {
  return (await view()) === "app" ? BOARD_METADATA : LANDING_METADATA;
}

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if ((await view()) === "landing") return <Landing />;
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const k of FEED_FILTERS) {
    const v = sp[k];
    const one = Array.isArray(v) ? v[0] : v;
    if (one) qs.set(k, one);
  }
  if ([...qs.keys()].length > 0) redirect(`/feed?${qs}`);
  const all = Array.isArray(sp.all) ? sp.all[0] : sp.all;
  return <BoardPage all={all} />;
}
