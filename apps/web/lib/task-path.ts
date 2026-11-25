/**
 * A task's page: `/tasks/<id>`, where the ID is the one the board gave the task's thread. On its own so client
 * components (the feed's rows) can link to a task without loading the board's vocabulary.
 */
export const taskPagePath = (id: string): string => `/tasks/${encodeURIComponent(id)}`;
