import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/api";
import { SITE_URL } from "@/lib/data";

/** RFC 9728 protected resource metadata. Tokens are minted by the relay CLI, not an authorization server. */
export function GET() {
  return NextResponse.json(
    {
      resource: SITE_URL,
      authorization_servers: [],
      bearer_methods_supported: ["header"],
      scopes_supported: SCOPES,
      resource_name: "relay",
      resource_documentation: `${SITE_URL}/docs/api#authentication-and-scopes`,
      resource_policy_uri: `${SITE_URL}/docs/versioning`,
      // Non-standard but useful: how a token comes to exist.
      token_issuance: "relay token create --name <name> --scopes <scopes>  (runs on a machine with the database connection; the hash is stored, the token shown once)",
      public_read_endpoints: [`${SITE_URL}/api/v1/info`, `${SITE_URL}/api/v1/feed`, `${SITE_URL}/api/v1/projects`],
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}
