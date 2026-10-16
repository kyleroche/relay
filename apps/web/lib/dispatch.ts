/**
 * Outbound webhooks from the web app. Every route that writes feed rows (the GitHub and Vercel ingest, the API event
 * writers, the MCP tools) hands them to `dispatchAfter`, which schedules the fan-out with Next's `after()` so the
 * response never waits on a receiver. Delivery outcomes land in `webhook_deliveries`; nothing here throws.
 */
import { dispatchEvent, repo } from "@relay/core";
import { after } from "next/server";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import type { FeedEvent } from "@/lib/types";

type Row = repo.EventRow | FeedEvent;

const asRow = (e: Row): repo.EventRow => ({ ...e, kind: e.kind, lane: e.lane, subscription: e.subscription }) as repo.EventRow;

/** Deliver to matching webhooks after the response is sent. Mock mode has no hooks table and does nothing. */
export function dispatchAfter(rows: Array<Row | null | undefined>): void {
  if (dataMode() !== "db") return;
  const live = rows.filter((r): r is Row => !!r);
  if (!live.length) return;
  const run = async () => {
    const db = await getDb();
    for (const r of live) await dispatchEvent(db, asRow(r)).catch(() => []);
  };
  try {
    after(run);
  } catch {
    // outside a request scope (tests, scripts): run inline, still never throwing
    void run().catch(() => {});
  }
}

/** The MCP server's afterEvent hook: same path, one row at a time. */
export const dispatchOne = (row: repo.EventRow): void => dispatchAfter([row]);
