"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the server page every `ms` while the tab is visible, and once more when it becomes visible again.
 * `router.refresh()` keeps client state (an open sheet, a half-written note), so a card's form survives the tick.
 */
export function AutoRefresh({ ms = 20_000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id === null) id = setInterval(() => router.refresh(), ms);
    };
    const stop = () => {
      if (id !== null) clearInterval(id);
      id = null;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, ms]);
  return null;
}
