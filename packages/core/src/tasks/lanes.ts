/**
 * The lane vocabulary. A lane is who runs a task: one of the four `relay work` serves on a machine's own logins, a
 * lane some other worker registered for itself, or `any` (whichever code lane is free). On the board it is the
 * task's `lane` label.
 */
export const CODE_LANES = ["claude", "codex", "grok"] as const;
/** The lanes `relay work` serves: the code lanes on the vendors' CLIs, and Griptape Nodes. */
export const WORKER_LANES = [...CODE_LANES, "nodes"] as const;
/** The same four, by the name that says what they are now that other lanes exist. */
export const BUILTIN_LANES = WORKER_LANES;
/** Claimed by any worker that serves a code lane; the worker runs it on the first of its code lanes that is free. */
export const ANY_LANE = "any";
export type CodeLane = (typeof CODE_LANES)[number];
export type WorkerLane = (typeof WORKER_LANES)[number];
export const isCodeLane = (s: string): s is CodeLane => (CODE_LANES as readonly string[]).includes(s);
export const isWorkerLane = (s: string): s is WorkerLane => (WORKER_LANES as readonly string[]).includes(s);

/** The shape of a lane name, as a pattern source for composed regexes (branches, OpenAPI). */
export const LANE_NAME_PATTERN = "[a-z][a-z0-9-]{0,31}";
export const LANE_NAME = new RegExp(`^${LANE_NAME_PATTERN}$`);
/** The rule in words, for every message that refuses a name. */
export const LANE_NAME_RULE = "lowercase letters, digits and dashes, 1 to 32 characters, starting with a letter";
export const isLaneName = (s: string): boolean => LANE_NAME.test(s);
export const laneNameProblem = (lane: string): string => `lane '${lane}' is not a lane name (${LANE_NAME_RULE})`;

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const isTaskPriority = (s: string): s is TaskPriority => (TASK_PRIORITIES as readonly string[]).includes(s);

/**
 * Why a task cannot be opened on `lane`, or undefined when it can. The built-in lanes and `any` always can; any
 * other lane needs a worker that has registered it, so a typo never opens a task nobody will claim.
 */
export function laneUnservedProblem(lane: string, registered: readonly string[]): string | undefined {
  if (isWorkerLane(lane) || lane === ANY_LANE || registered.includes(lane)) return undefined;
  const others = registered.filter((l) => !isWorkerLane(l));
  return `no worker serves lane '${lane}'; lanes with a worker: ${others.length ? others.join(", ") : "none besides the built-in ones"}; built-in: ${BUILTIN_LANES.join(", ")}, ${ANY_LANE}`;
}
