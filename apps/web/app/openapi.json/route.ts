import { NextResponse } from "next/server";
import { RATE_LIMIT, SCOPES } from "@/lib/api";
import { SITE_URL } from "@/lib/data";
import { EVENT_KIND_LIST } from "@/lib/events";
import { APP_VERSION } from "@/lib/info-doc";

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
    "WWW-Authenticate": { schema: { type: "string" }, description: "Bearer challenge naming the required scope and the protected-resource metadata URL." },
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
      summary: "Read model over relay's event feed, projects and plan usage.",
      description: `The same data as the site, as JSON. Rate limited to ${RATE_LIMIT.limit} requests per ${RATE_LIMIT.windowSeconds} seconds per client; every response carries RateLimit-Policy and RateLimit headers and 429 includes Retry-After. Errors are RFC 9457 application/problem+json. Versioning and deprecation policy: ${SITE_URL}/docs/versioning (RFC 9745 Deprecation and Sunset headers when an operation is retired).`,
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      contact: { name: "relay", url: `${SITE_URL}/info` },
      "x-rate-limit": { policy: RATE_LIMIT.policyName, requests: RATE_LIMIT.limit, window_seconds: RATE_LIMIT.windowSeconds },
    },
    externalDocs: { description: "API and MCP guide", url: `${SITE_URL}/docs/api` },
    servers: [{ url: `${SITE_URL}/api/v1` }],
    tags: [
      { name: "info", description: "What this deployment is." },
      { name: "feed", description: "The append-only event feed." },
      { name: "projects", description: "Linked repositories, decisions and models." },
    ],
    security: [{}, { bearer: ["feed:read"] }],
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
    },
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description: `Bearer token minted with the relay CLI. Scopes: ${SCOPES.join(", ")}. Read operations need no token when the deployment enables public read. Protected-resource metadata: ${SITE_URL}/.well-known/oauth-protected-resource`,
          "x-scopes": {
            "feed:read": "Read the feed and projects.",
            "memory:read": "Read decisions and guidance through MCP.",
            "memory:write": "Capture decisions through MCP.",
          },
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
      },
    },
  };
  return NextResponse.json(doc, { headers: { "cache-control": "public, max-age=300" } });
}
