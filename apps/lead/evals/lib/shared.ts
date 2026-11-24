/** What the evals share: the names eve reports relay's tools under, and checks several of them make. */
import type { EveEvalStreamEvent } from "eve/evals";
import { qualified, RELAY_TOOLS } from "../../agent/lib/relay-tools.ts";

/** eve reports a connection's tool as `<connection>__<tool>`, whether the model called it directly or through `eve__tool`. */
export const relay = {
  create: qualified("relay_task_create"),
  get: qualified("relay_task_get"),
  list: qualified("relay_task_list"),
  requeue: qualified("relay_task_requeue"),
  requestChanges: qualified("relay_task_request_changes"),
  recall: qualified("relay_recall"),
  project: qualified("relay_project"),
  feed: qualified("relay_feed"),
  eventLog: qualified("relay_event_log"),
  approve: qualified("relay_task_approve"),
  release: qualified("relay_task_release"),
  close: qualified("relay_task_close"),
} as const;

/** Everything the lead may call: its relay tools, `no_reply`, and eve's own catalog tools for finding and calling them. */
const ALLOWED = new Set<string>([...RELAY_TOOLS.map(qualified), "no_reply", "eve__search", "eve__tool"]);

/** The names of the tools a run asked for that are not the lead's to call. Empty is the passing answer. */
export function callsOutsideTheList(events: readonly EveEvalStreamEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== "call.requested") continue;
    const name = e.data.capability.name;
    if (!ALLOWED.has(name)) out.push(name);
  }
  return out;
}

/** A task body as the instructions ask for it: the three headings in order, and a done-check that says something. */
export function isRunnableTask(input: { body?: unknown; title?: unknown }): boolean {
  const body = typeof input.body === "string" ? input.body : "";
  const title = typeof input.title === "string" ? input.title : "";
  const sections = /## Do\b[\s\S]+## Out of scope\b[\s\S]+## Done when\b([\s\S]+)$/.exec(body);
  return title.length > 0 && title.length <= 80 && !!sections && sections[1]!.trim().length >= 10;
}

/** How many questions a reply asks. "One question" is counted, not judged. */
export const questions = (reply: string | undefined): number => (reply?.match(/\?/g) ?? []).length;
