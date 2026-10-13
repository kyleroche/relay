import { cookies } from "next/headers";

/** Viewer time zone from the relay-tz cookie (set by components/shell/tz-sync.tsx), else UTC. Server only. */
export async function viewerTimeZone(): Promise<string> {
  const raw = (await cookies()).get("relay-tz")?.value;
  if (!raw) return "UTC";
  try {
    const tz = decodeURIComponent(raw);
    // Throws on an unknown zone name.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}
