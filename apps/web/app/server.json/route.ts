import { NextResponse } from "next/server";
import { serverJson } from "@/lib/mcp-meta";

export function GET() {
  return NextResponse.json(serverJson(), { headers: { "cache-control": "public, max-age=3600" } });
}
