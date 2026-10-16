/** Site constants with no imports, so any module (including the data adapters) can use them without cycles. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? process.env.RELAY_PUBLIC_URL ?? "https://relay.kyro.house").replace(/\/$/, "");
export const REPO_URL = "https://github.com/kyleroche/relay";
export const ISSUES_URL = `${REPO_URL}/issues`;
export const SECURITY_DOC_URL = `${REPO_URL}/blob/main/docs/SECURITY.md`;
export const LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0";

/** Who makes relay. Shown on the landing and the about page and in the Organization JSON-LD. */
export const AUTHOR = { name: "Kyle Roche", url: "https://github.com/kyleroche" } as const;

/**
 * The operator's contact address, when the deployment sets RELAY_CONTACT_EMAIL. Undefined otherwise; nothing on the
 * site invents one. A value that does not look like an address is ignored rather than published.
 */
export function contactEmail(env: Record<string, string | undefined> = process.env): string | undefined {
  const v = env.RELAY_CONTACT_EMAIL?.trim();
  return v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : undefined;
}
