const entries = new Map();

export function get(key) {
  return entries.get(key)?.value;
}

export function set(key, value) {
  entries.set(key, { value });
}
