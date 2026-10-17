/**
 * Fetch metadata as a second line against cross-site requests. The session cookie is `SameSite=Lax`, which already
 * keeps it off cross-site POSTs; `Sec-Fetch-Site` lets the decision route and the server actions refuse such a
 * request outright even if a browser or a future cookie change sends the cookie anyway. Browsers set the header
 * themselves and a page cannot forge it; a request without it (an old browser, a CLI) is not treated as cross-site.
 */
export function isCrossSite(headers: { get(name: string): string | null }): boolean {
  return (headers.get("sec-fetch-site") ?? "").trim().toLowerCase() === "cross-site";
}

export const CROSS_SITE_MESSAGE = "Cross-site request refused: open this page on the site itself and try again.";
