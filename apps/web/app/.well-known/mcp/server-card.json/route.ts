import { NextResponse } from "next/server";
import { serverCard } from "@/lib/mcp-meta";

export function GET() {
  return NextResponse.json(serverCard(), { headers: { "cache-control": "public, max-age=3600" } });
}
