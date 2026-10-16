import type { Metadata } from "next";
import { Landing, LANDING_METADATA } from "@/components/landing/landing";

/**
 * The public landing, always. Anonymous visitors get the same page at /, which is the canonical address; /info stays
 * so signed-in viewers (whose / is the feed) and old links can still reach it.
 */
export const metadata: Metadata = LANDING_METADATA;

export default function InfoPage() {
  return <Landing />;
}
