/** Site constants with no imports, so any module (including the data adapters) can use them without cycles. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? process.env.RELAY_PUBLIC_URL ?? "https://relay.kyro.house").replace(/\/$/, "");
export const REPO_URL = "https://github.com/kyleroche/relay"
