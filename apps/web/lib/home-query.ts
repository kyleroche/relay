/**
 * What the query string on `/` means. The feed lived at `/` before the board, so a feed filter link (`lane`, `actor`,
 * `kind`) still lands on `/feed` with its filters; `project` filters the board itself (`all` means every project,
 * the default), and `all=<column>` opens one column in full (components/board/board.tsx). Pure, for the test.
 */
export type SearchParams = Record<string, string | string[] | undefined>;

export const FEED_ONLY_FILTERS = ["lane", "actor", "kind"] as const;

export type HomeQuery = { redirect: string } | { project?: string; all?: string };

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v) || undefined;

export function homeQuery(sp: SearchParams): HomeQuery {
  const project = first(sp.project);
  const qs = new URLSearchParams();
  for (const k of FEED_ONLY_FILTERS) {
    const v = first(sp[k]);
    if (v) qs.set(k, v);
  }
  if ([...qs.keys()].length > 0) {
    // a feed filter: the whole filter goes along, project included
    if (project && project !== "all") qs.set("project", project);
    return { redirect: `/feed?${qs}` };
  }
  const out: { project?: string; all?: string } = {};
  if (project && project !== "all") out.project = project;
  const all = first(sp.all);
  if (all) out.all = all;
  return out;
}
