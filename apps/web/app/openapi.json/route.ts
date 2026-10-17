import { NextResponse } from "next/server";
import { RATE_LIMIT, SCOPES } from "@/lib/api";
import { SITE_URL } from "@/lib/data";
import { EVENT_KIND_LIST } from "@/lib/events";
import { APP_VERSION } from "@/lib/info-doc";
import { ASSET_KINDS, ASSET_STATUSES } from "@/lib/types";
import { integrationPaths, integrationSchemas, integrationTags, scopeDescriptions } from "@/lib/openapi-ext";

const problemSchema = {
  type: "object",
  description: "RFC 9457 problem details.",
  required: ["type", "title", "status"],
  properties: {
    type: { type: "string", format: "uri" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
  },
};

const rateLimitHeaders = {
  "RateLimit-Policy": { description: `Structured policy, e.g. "${RATE_LIMIT.policyName}";q=${RATE_LIMIT.limit};w=${RATE_LIMIT.windowSeconds}.`, schema: { type: "string" } },
  RateLimit: { description: 'Structured state: remaining requests (r) and seconds to reset (t), e.g. "default";r=57;t=42.', schema: { type: "string" } },
};

function response(description: string, schemaRef: string) {
  return {
    description,
    headers: rateLimitHeaders,
    content: { "application/json": { schema: { $ref: schemaRef } } },
  };
}

function problemResponse(description: string, extraHeaders: Record<string, unknown> = {}) {
  return {
    description,
    headers: { ...rateLimitHeaders, ...extraHeaders },
    content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
  };
}

const commonErrors = {
  "401": problemResponse("Missing or unknown bearer token (when public read is disabled).", {
    "WWW-Authenticate": { schema: { type: "string" }, description: "Bearer challenge naming the required scope." },
  }),
  "403": problemResponse("Token lacks the required scope."),
  "429": problemResponse("Rate limit exceeded.", { "Retry-After": { schema: { type: "integer" }, description: "Seconds until the window resets." } }),
  "500": problemResponse("Unexpected error."),
};

export function GET() {
  const doc = {
    openapi: "3.1.0",
    info: {
      title: "relay API",
      version: APP_VERSION,
      summary: "Read model over relay's event feed, projects and plan usage, plus the asset library's upload and review loop.",
      description: `The same data as the site, as JSON. Rate limited to ${RATE_LIMIT.limit} requests per ${RATE_LIMIT.windowSeconds} seconds per client; every response carries RateLimit-Policy and RateLimit headers and 429 includes Retry-After. Errors are RFC 9457 application/problem+json. Versioning and deprecation policy: ${SITE_URL}/docs/versioning (RFC 9745 Deprecation and Sunset headers when an operation is retired).`,
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      contact: { name: "relay", url: `${SITE_URL}/contact` },
      "x-rate-limit": { policy: RATE_LIMIT.policyName, requests: RATE_LIMIT.limit, window_seconds: RATE_LIMIT.windowSeconds },
    },
    externalDocs: { description: "API and MCP guide", url: `${SITE_URL}/docs/api` },
    servers: [{ url: `${SITE_URL}/api/v1` }],
    tags: [
      { name: "info", description: "What this deployment is." },
      { name: "feed", description: "The append-only event feed." },
      { name: "projects", description: "Linked repositories, decisions and models." },
      { name: "assets", description: "The asset library: media agents produce, versioned, with an approve-or-reject review loop (docs/ASSETS.md)." },
      ...integrationTags,
    ],
    security: [{}, { bearer: ["feed:read"] }, { oauth2: ["feed:read"] }],
    paths: {
      "/info": {
        get: {
          operationId: "getInfo",
          tags: ["info"],
          summary: "Describe this relay deployment",
          description: "Name, version, the five rules, a task's life, data mode, and links to every machine-readable surface. Always public.",
          security: [{}],
          responses: { "200": response("The info document.", "#/components/schemas/Info"), "429": commonErrors["429"], "500": commonErrors["500"] },
        },
      },
      "/feed": {
        get: {
          operationId: "listFeed",
          tags: ["feed"],
          summary: "List events, newest first",
          description: "Sanitized events (no raw payload, no dedupe key). Page backwards with before=<ts of the oldest event you have>; poll forwards with after=<ts of the newest>.",
          parameters: [
            { name: "project", in: "query", schema: { type: "string" }, description: "Project slug." },
            { name: "kind", in: "query", schema: { type: "string", enum: EVENT_KIND_LIST }, description: "Event kind." },
            { name: "actor", in: "query", schema: { type: "string" }, description: "Actor, e.g. runner:studio." },
            { name: "lane", in: "query", schema: { type: "string", enum: ["claude", "codex", "grok"] } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
            { name: "before", in: "query", schema: { type: "string", format: "date-time" }, description: "Strictly older than this timestamp." },
            { name: "after", in: "query", schema: { type: "string", format: "date-time" }, description: "Strictly newer than this timestamp." },
          ],
          responses: {
            "200": response("A page of events.", "#/components/schemas/FeedPage"),
            "400": problemResponse("Invalid parameter."),
            ...commonErrors,
          },
        },
      },
      "/projects": {
        get: {
          operationId: "listProjects",
          tags: ["projects"],
          summary: "List linked projects",
          responses: { "200": response("All projects.", "#/components/schemas/ProjectList"), ...commonErrors },
        },
      },
      "/projects/{slug}": {
        get: {
          operationId: "getProject",
          tags: ["projects"],
          summary: "One project with decisions, models and recent events",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": response("The project.", "#/components/schemas/ProjectDetail"), "404": problemResponse("No such project."), ...commonErrors },
        },
      },
      "/assets": {
        get: {
          operationId: "listAssets",
          tags: ["assets"],
          summary: "List assets, pending first",
          description: "Pending assets come first, then newest first. View URLs are signed and expire after an hour.",
          security: [{ bearer: ["assets:read"] }],
          parameters: [
            { name: "project", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string", enum: ASSET_STATUSES } },
            { name: "kind", in: "query", schema: { type: "string", enum: ASSET_KINDS } },
            { name: "issue", in: "query", schema: { type: "integer" } },
            { name: "pr", in: "query", schema: { type: "integer" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: { "200": response("A page of assets.", "#/components/schemas/AssetList"), "400": problemResponse("Invalid parameter."), ...commonErrors },
        },
        post: {
          operationId: "createAsset",
          tags: ["assets"],
          summary: "Upload an asset, or reserve a presigned upload",
          description:
            "Two bodies. multipart/form-data with a `file` part and the metadata fields ingests the bytes here and returns the asset (201). application/json with `presign: true` returns an asset id and a one-time upload URL: PUT the bytes to `upload_url` with the returned content-type header, then POST `finalize_body` to `/assets/{id}/finalize`. Uploads need a database and an asset store; mock deployments answer 501.",
          security: [{ bearer: ["assets:write"] }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": { schema: { $ref: "#/components/schemas/AssetUploadForm" } },
              "application/json": { schema: { $ref: "#/components/schemas/PresignRequest" } },
            },
          },
          responses: {
            "201": {
              description: "The asset (multipart) or the presigned upload (JSON).",
              headers: rateLimitHeaders,
              content: { "application/json": { schema: { oneOf: [{ $ref: "#/components/schemas/Asset" }, { $ref: "#/components/schemas/PresignResponse" }] } } },
            },
            "400": problemResponse("Bad body or metadata."),
            "404": problemResponse("No such project."),
            "501": problemResponse("No asset store in this deployment."),
            ...commonErrors,
          },
        },
      },
      "/assets/{id}": {
        get: {
          operationId: "getAsset",
          tags: ["assets"],
          summary: "One asset with its version chain and signed view URLs",
          security: [{ bearer: ["assets:read"] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": response("The asset.", "#/components/schemas/AssetDetail"), "404": problemResponse("No such asset."), ...commonErrors },
        },
      },
      "/assets/{id}/finalize": {
        post: {
          operationId: "finalizeAsset",
          tags: ["assets"],
          summary: "Finish a presigned upload",
          description: "Probes the uploaded object (mime, dimensions, duration), renders a thumbnail when a helper is available, and creates the row under the reserved id. A second call answers 409.",
          security: [{ bearer: ["assets:write"] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/FinalizeRequest" } } } },
          responses: {
            "201": response("The asset.", "#/components/schemas/Asset"),
            "400": problemResponse("Bad key or metadata."),
            "404": problemResponse("Nothing was uploaded to the key."),
            "409": problemResponse("Already finalized."),
            "501": problemResponse("No asset store in this deployment."),
            ...commonErrors,
          },
        },
      },
      "/assets/{id}/review": {
        put: {
          operationId: "reviewAsset",
          tags: ["assets"],
          summary: "Approve or reject",
          description:
            "Writes asset.reviewed. A rejection needs a note; the note becomes a project decision (source `review`) so the next attempt's brief carries it. With a GitHub token configured the decision is also commented on the task, and a rejection reopens the issue.",
          security: [{ bearer: ["assets:review"] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ReviewRequest" } } } },
          responses: { "200": response("The reviewed asset.", "#/components/schemas/Asset"), "400": problemResponse("Bad decision or missing note."), "404": problemResponse("No such asset."), ...commonErrors },
        },
      },
      "/assets/{id}/publish": {
        post: {
          operationId: "publishAsset",
          tags: ["assets"],
          summary: "Copy to the public store and record a permanent URL",
          security: [{ bearer: ["assets:write"] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": response("The published asset; public_url is set.", "#/components/schemas/Asset"),
            "404": problemResponse("No such asset."),
            "501": problemResponse("This deployment has no public store (BLOB_PUBLIC_READ_WRITE_TOKEN)."),
            ...commonErrors,
          },
        },
      },
      ...integrationPaths({ response, problemResponse, commonErrors }),
    },
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description: `Bearer token. Three ways to get one, all ending in a row of the same tokens table: (1) OAuth 2.1 from this site's authorization server (${SITE_URL}/.well-known/oauth-authorization-server): authorization code with PKCE S256 for clients with a browser, the RFC 8628 device flow for CLIs and bots (relay setup --site <url> prints a code the operator approves at ${SITE_URL}/activate), or the urn:relay:invite grant with a one-time code from relay invite create; access tokens last 24 hours, refresh tokens 90 days with rotation. (2) relay token create --name <name> --scopes <scopes> on the operator's machine. (3) the /tokens page while signed in. Only the SHA-256 is stored and the token is shown once. Scopes: ${SCOPES.join(", ")}. Read operations need no token when the deployment enables public read. Every 401 carries WWW-Authenticate with resource_metadata pointing at ${SITE_URL}/.well-known/oauth-protected-resource (RFC 9728).`,
          "x-token-issuance": "relay token create --name <name> --scopes <scopes>, relay invite create --for <name> --scopes <scopes>, or OAuth at /oauth/*",
          "x-scopes": scopeDescriptions,
          "x-authorization-server": `${SITE_URL}/.well-known/oauth-authorization-server`,
          "x-resource-metadata": `${SITE_URL}/.well-known/oauth-protected-resource`,
        },
        oauth2: {
          type: "oauth2",
          description: `OAuth 2.1 at this site. Register a client with POST ${SITE_URL}/oauth/register (RFC 7591, public clients), then the authorization code flow with PKCE (S256 required), or the device flow (POST ${SITE_URL}/oauth/device, approve at ${SITE_URL}/activate). Access tokens are the same bearer tokens as above (24 h); refresh tokens rotate on use (90 d). Revoke at POST ${SITE_URL}/oauth/revoke.`,
          flows: {
            authorizationCode: {
              authorizationUrl: `${SITE_URL}/oauth/authorize`,
              tokenUrl: `${SITE_URL}/oauth/token`,
              refreshUrl: `${SITE_URL}/oauth/token`,
              scopes: scopeDescriptions,
            },
          },
          "x-device-authorization-url": `${SITE_URL}/oauth/device`,
          "x-registration-url": `${SITE_URL}/oauth/register`,
          "x-revocation-url": `${SITE_URL}/oauth/revoke`,
          "x-grant-types": ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code", "urn:relay:invite"],
        },
      },
      schemas: {
        Problem: problemSchema,
        Info: {
          type: "object",
          required: ["name", "version", "description", "rules", "links"],
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            tagline: { type: "string" },
            description: { type: "string" },
            license: { type: "string" },
            free: { type: "boolean" },
            repository: { type: "string", format: "uri" },
            site: { type: "string", format: "uri" },
            data_mode: { type: "string", enum: ["mock", "db"] },
            public_read: { type: "boolean" },
            rules: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, title: { type: "string" }, body: { type: "string" } } } },
            task_flow: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, step: { type: "string" }, where: { type: "string" }, detail: { type: "string" } } } },
            links: { type: "object", additionalProperties: { type: "string", format: "uri" } },
          },
        },
        Event: {
          type: "object",
          required: ["id", "ts", "kind", "actor", "summary"],
          properties: {
            id: { type: "integer" },
            ts: { type: "string", format: "date-time" },
            kind: { type: "string", enum: EVENT_KIND_LIST },
            actor: { type: "string", description: "<kind>:<name>, kind in human, bot, runner, agent." },
            project: { type: ["string", "null"] },
            repo: { type: ["string", "null"] },
            issue: { type: ["integer", "null"] },
            pr: { type: ["integer", "null"] },
            lane: { type: ["string", "null"] },
            model: { type: ["string", "null"] },
            subscription: { type: ["string", "null"] },
            tokens_in: { type: "integer" },
            tokens_out: { type: "integer" },
            cache_read: { type: "integer" },
            cache_write: { type: "integer" },
            cost_equiv: { type: "number", description: "USD at gateway list price." },
            duration_ms: { type: ["integer", "null"] },
            summary: { type: "string" },
            url: { type: ["string", "null"], format: "uri" },
          },
        },
        FeedPage: {
          type: "object",
          required: ["events", "count"],
          properties: {
            events: { type: "array", items: { $ref: "#/components/schemas/Event" } },
            count: { type: "integer" },
            next_before: { type: ["string", "null"], format: "date-time", description: "Pass as before= to fetch the next older page; null at the end." },
          },
        },
        Digest: { type: "object", properties: { digested: { type: "integer" }, total: { type: "integer" } } },
        Project: {
          type: "object",
          required: ["slug", "repo"],
          properties: {
            slug: { type: "string" },
            repo: { type: "string" },
            stack: { type: ["string", "null"] },
            summary: { type: ["string", "null"] },
            lastActivity: { type: ["string", "null"], format: "date-time" },
            openIssues: { type: "integer" },
            decisionsCount: { type: "integer" },
            digest: { $ref: "#/components/schemas/Digest" },
            lanes: { type: "array", items: { type: "string" } },
          },
        },
        ProjectList: { type: "object", properties: { projects: { type: "array", items: { $ref: "#/components/schemas/Project" } }, count: { type: "integer" } } },
        Decision: {
          type: "object",
          properties: {
            id: { type: "integer" },
            project: { type: "string" },
            text: { type: "string" },
            source: { type: "string" },
            source_ref: { type: ["string", "null"] },
            valid_from: { type: "string", format: "date-time" },
          },
        },
        Model: {
          type: "object",
          properties: {
            id: { type: "string" },
            provider: { type: "string" },
            lanes: { type: "array", items: { type: "string" } },
            onboarded_at: { type: ["string", "null"], format: "date-time" },
            guidance_count: { type: "integer" },
            skill_count: { type: "integer" },
            stale_days: { type: "integer" },
            status: { type: "string", enum: ["ready", "stale", "pending"] },
          },
        },
        ProjectDetail: {
          allOf: [
            { $ref: "#/components/schemas/Project" },
            {
              type: "object",
              properties: {
                check_cmd: { type: ["string", "null"] },
                decisions: { type: "array", items: { $ref: "#/components/schemas/Decision" } },
                models: { type: "array", items: { $ref: "#/components/schemas/Model" } },
                events: { type: "array", items: { $ref: "#/components/schemas/Event" } },
              },
            },
          ],
        },
        Asset: {
          type: "object",
          required: ["id", "title", "kind", "mime", "size", "version", "status", "created_by", "created_at"],
          properties: {
            id: { type: "string", description: "ULID." },
            project: { type: ["string", "null"] },
            issue: { type: ["integer", "null"] },
            pr: { type: ["integer", "null"] },
            title: { type: "string" },
            description: { type: ["string", "null"] },
            kind: { type: "string", enum: ASSET_KINDS },
            mime: { type: "string" },
            size: { type: "integer" },
            sha256: { type: "string" },
            width: { type: ["integer", "null"] },
            height: { type: ["integer", "null"] },
            duration_ms: { type: ["integer", "null"] },
            version: { type: "integer" },
            parent_id: { type: ["string", "null"], description: "The version this one replaced." },
            status: { type: "string", enum: ASSET_STATUSES },
            created_by: { type: "string", description: "Actor, e.g. bot:grok, runner:mini, token:ci." },
            created_at: { type: "string", format: "date-time" },
            reviewed_by: { type: ["string", "null"] },
            reviewed_at: { type: ["string", "null"], format: "date-time" },
            review_note: { type: ["string", "null"] },
            public_url: { type: ["string", "null"], format: "uri", description: "Set only after publish." },
            expires_at: { type: ["string", "null"], format: "date-time", description: "Retention deadline for rejected and superseded versions." },
            tags: { type: "array", items: { type: "string" } },
            url: { type: ["string", "null"], format: "uri", description: "Signed view URL for the bytes; expires after about an hour." },
            thumb_url: { type: ["string", "null"], format: "uri" },
            bundle_url: { type: ["string", "null"], format: "uri", description: "kind=html only: the index entry, to show in a sandboxed iframe." },
          },
        },
        AssetVersion: {
          type: "object",
          properties: {
            id: { type: "string" },
            version: { type: "integer" },
            status: { type: "string", enum: ASSET_STATUSES },
            created_at: { type: "string", format: "date-time" },
            created_by: { type: "string" },
            thumb_url: { type: ["string", "null"], format: "uri" },
          },
        },
        AssetDetail: {
          allOf: [
            { $ref: "#/components/schemas/Asset" },
            {
              type: "object",
              properties: {
                versions: { type: "array", items: { $ref: "#/components/schemas/AssetVersion" } },
                task_url: { type: ["string", "null"], format: "uri", description: "The GitHub issue or PR." },
              },
            },
          ],
        },
        AssetList: { type: "object", required: ["assets", "count"], properties: { assets: { type: "array", items: { $ref: "#/components/schemas/Asset" } }, count: { type: "integer" } } },
        AssetMetadata: {
          type: "object",
          required: ["project"],
          properties: {
            project: { type: "string", description: "Project slug; must exist." },
            issue: { type: "integer" },
            pr: { type: "integer" },
            title: { type: "string", description: "Defaults to the file name, or the replaced version's title." },
            description: { type: "string" },
            replaces: { type: "string", description: "Asset id this upload supersedes; the new row becomes the next version." },
            tags: { type: "array", items: { type: "string" }, description: "In multipart form, a comma-separated string." },
            by: { type: "string", description: "Creator actor; defaults to the token's name." },
          },
        },
        AssetUploadForm: { allOf: [{ $ref: "#/components/schemas/AssetMetadata" }, { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } }] },
        PresignRequest: {
          allOf: [
            { $ref: "#/components/schemas/AssetMetadata" },
            {
              type: "object",
              required: ["presign", "filename"],
              properties: { presign: { type: "boolean", const: true }, filename: { type: "string" }, content_type: { type: "string", description: "Sniffed from the filename when omitted." } },
            },
          ],
        },
        PresignResponse: {
          type: "object",
          required: ["id", "key", "upload_url", "method", "expires_at", "finalize_url", "finalize_body"],
          properties: {
            id: { type: "string" },
            key: { type: "string", description: "Storage key: <project>/<id>/<filename>." },
            upload_url: { type: "string", format: "uri", description: "PUT the bytes here (Vercel Blob presigned URL, or this app's /api/assets/upload for the local store)." },
            method: { type: "string", const: "PUT" },
            headers: { type: "object", additionalProperties: { type: "string" } },
            expires_at: { type: "string", format: "date-time" },
            finalize_url: { type: "string", format: "uri" },
            finalize_body: { $ref: "#/components/schemas/FinalizeRequest" },
          },
        },
        FinalizeRequest: { allOf: [{ $ref: "#/components/schemas/AssetMetadata" }, { type: "object", required: ["key"], properties: { key: { type: "string" } } }] },
        ReviewRequest: {
          type: "object",
          required: ["decision"],
          properties: {
            decision: { type: "string", enum: ["approved", "rejected"] },
            note: { type: "string", description: "Required for a rejection." },
            by: { type: "string", description: "Reviewer actor; defaults to the token's name." },
          },
        },
        ...integrationSchemas,
      },
    },
  };
  return NextResponse.json(doc, { headers: { "cache-control": "public, max-age=300" } });
}
