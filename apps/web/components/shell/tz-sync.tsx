"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export const TZ_COOKIE = "relay-tz";

/**
 * Server pages format times in the viewer's zone so the feed can be fully server-rendered
 * with no hydration drift. The zone travels in a cookie; this sets it on first visit and
 * refreshes once so the current page re-renders in local time.
 */
export function TimezoneSync({ current }: { current: string }) {
  const router = useRouter();
  useEffect(() => {
    let tz = "UTC";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return;
    }
    if (tz === current) return;
    document.cookie = `${TZ_COOKIE}=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [current, router]);
  return null;
}
