import type { NextRequest } from "next/server";
import { problem, rateHeaders, takeToken, clientKey } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Unknown /api/v1 paths answer 404 as problem+json, never an HTML shell. */
function notFound(req: NextRequest) {
  const rate = takeToken(clientKey(req));
  return problem(404, "Not Found", "No such operation. See /openapi.json for the list.", req.nextUrl.pathname, {}, rateHeaders(rate));
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
