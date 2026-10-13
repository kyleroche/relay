import { NextResponse } from "next/server";
import { fullMarkdown } from "@/lib/docs";

/** Every doc concatenated, for agents that want the whole thing in one request. */
export function GET() {
  return new NextResponse(fullMarkdown(), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
