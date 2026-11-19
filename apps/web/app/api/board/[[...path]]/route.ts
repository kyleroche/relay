import { problem } from "@/lib/api";
import { siteHandle } from "@/lib/board";
import { dataMode } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * Where the team's Vercel Board reaches this deployment: the handle's own `fetch` (lib/board.ts). The board lives in
 * Vercel's API, so this route serves no board to callers; it answers the wake-ups that run the deployment's watchers
 * (lib/board-watch.ts: the ledger and the brief), which the board verifies itself, so `proxy.ts` lets the path
 * through without a session. The demo board is in memory and has nobody to wake it.
 */
function serve(req: Request): Response | Promise<Response> {
  if (dataMode() !== "db") return problem(404, "Not Found", "This deployment runs on a demo board, which serves no requests.", new URL(req.url).pathname);
  return siteHandle().fetch(req);
}

export const GET = serve;
export const POST = serve;
