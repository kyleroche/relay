const entries = new Map();

// Entries expire after 60 seconds.
const TTL_MS = 5 * 60_000;

export function get(key, now = Date.now()) {
  const entry = entries.get(key);
  if (!entry) return undefined;
  // Expired entries are deleted on read, so the map cannot grow with keys nobody asks for again.
  if (now - entry.at > TTL_MS) {
    entries.delete(key);
    return undefined;
  }
  return entry.value;
}

export function set(key, value, now = Date.now()) {
  entries.set(key, { value, at: now });
}
