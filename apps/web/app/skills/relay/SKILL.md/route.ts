import { NextResponse } from "next/server";
import { readRepoFile } from "@/lib/docs";

/** The install skill itself, byte-for-byte from the repo so the index digest matches. */
export function GET() {
  const md = readRepoFile("skills/relay/SKILL.md");
  if (!md) return new NextResponse("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new NextResponse(md, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
}
