/** Time formatting in an explicit IANA zone. Safe for client and server; the cookie read lives in tz-server.ts. */

export function clockIn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

export function dateIn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}

export function dayKeyIn(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function dayLabelIn(iso: string, tz: string, now: number = Date.now()): string {
  const key = dayKeyIn(iso, tz);
  const today = dayKeyIn(new Date(now).toISOString(), tz);
  const yesterday = dayKeyIn(new Date(now - 86_400_000).toISOString(), tz);
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" }).format(new Date(iso));
}
