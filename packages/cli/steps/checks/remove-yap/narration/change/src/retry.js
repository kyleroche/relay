// Added exponential backoff as requested in the task.
export async function retry(fn, attempts = 3, baseMs = 100) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // No sleep after the last attempt: the caller is about to get the error and should not wait for it.
      if (i < attempts - 1) {
        // wait before the next try
        await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
      }
    }
  }
  throw last;
}
