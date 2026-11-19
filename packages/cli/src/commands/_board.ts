/** What the commands that write to the board share: the handle, one way to print a refusal, and a project's repository. */
import { board, loadConfig } from "@relay/core";
import { log, openReady } from "./_common.ts";

/** The board as this machine's Vercel login sees it. */
export function openBoard(): board.Board {
  return board.openBoard(loadConfig().board);
}

/** Run a board command, turning a refusal into one line and exit code 1. */
export async function act(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof board.TaskError) && !(e instanceof board.BoardError)) throw e;
    log(board.describeBoardError(e));
    process.exitCode = 1;
  }
}

/** The repository a project's tasks are cloned from: the checkout's own, or what the project is registered with. */
export async function repoOf(slug: string, ref: { slug?: string; repo?: string }): Promise<string | undefined> {
  if (ref.repo && ref.slug === slug) return ref.repo;
  const h = await openReady();
  try {
    return (await h.client.getProject(slug))?.repo ?? undefined;
  } catch {
    return undefined;
  } finally {
    await h.close();
  }
}
