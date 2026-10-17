# Assets: media that is too large to share, with a review loop

Agents produce things that are not code: a short film from a cloud agent, a UX mockup, a rendered page, a storyboard. The asset library stores them privately, versions them, and gives a human an approve-or-reject path that writes back to the task and to memory. It is the visual counterpart of a pull request.

Code: `packages/core/src/db/assets.ts` (rows, review, retention), `packages/core/src/assets/` (`store.ts`, `ingest.ts`, `media.ts`, `index.ts`), `packages/cli/src/commands/assets.ts`, migration `packages/core/src/db/migrations/002_assets.sql`, tests `packages/core/test/assets.test.ts`.

## Storage

One interface, `AssetStore` (`packages/core/src/assets/store.ts`):

```ts
interface AssetStore {
  kind: "local" | "blob";
  put(key, data: Buffer | Readable, { contentType }): Promise<void>;
  getSignedUrl(key, ttlSeconds): Promise<string>;
  delete(key): Promise<void>;
  exists(key): Promise<boolean>;
  publish(key, { contentType }): Promise<string>;   // permanent public URL; Blob only
}
```

`openAssetStore()` returns `BlobStore` when `BLOB_READ_WRITE_TOKEN` is set, else `LocalStore`. Keys are relative paths `<project>/<asset id>/<sanitised filename>` (thumbnail: `<project>/<asset id>/thumb.webp|jpg`); the same key works in both adapters. Keys with `..`, empty segments, backslashes or a leading `/` are rejected.

### Production: Vercel Blob, private

`BlobStore` uses `@vercel/blob` 2.8 with `access: 'private'` throughout. Exact calls:

| operation | call |
|---|---|
| write | `put(key, body, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true, token })` |
| signed read | `issueSignedToken({ pathname: key, operations: ['get'], validUntil, token })` then `presignUrl(signedToken, { operation: 'get', pathname: key, access: 'private', validUntil })` → `presignedUrl` |
| exists | `head(key, { token })`; `BlobNotFoundError` means false |
| delete | `del(key, { token })` |
| publish | `get(key, { access: 'private', token }).stream` piped into `put(key, stream, { access: 'public', contentType, addRandomSuffix: false, allowOverwrite: true, token: BLOB_PUBLIC_READ_WRITE_TOKEN })` → `url` |

A private store never yields a permanent URL, so publishing needs a second, public store: set `BLOB_PUBLIC_READ_WRITE_TOKEN` to its read-write token. Without it `publish` throws `PublishUnsupportedError` and `relay asset publish` exits 2 with a note. Reference: https://vercel.com/docs/vercel-blob/using-blob-sdk (SDK), https://vercel.com/docs/vercel-blob (product). Create the private store with `vercel blob create-store <name> --access private`.

### Local development and tests: `~/.harness/assets/`

`LocalStore` writes under `${RELAY_HOME||~/.harness}/assets/<key>`. A fresh clone needs no account. Its signed URL is:

```
file:///<root>/<key>?exp=<unix seconds>&sig=<base64url HMAC-SHA256(secret, "<key>\n<exp>")>
```

- The secret is `RELAY_ASSET_SIGNING_KEY` when set, else 32 random bytes written once to `<root>/.signing-key` (mode 0600) on first use. Set the env var when the web app and the CLI run as different users or on different machines against the same folder.
- The web app never hands a `file://` URL to a browser. Its view route takes `key`, `exp` and `sig` (or the whole URL), calls `verifyLocalSignedUrl(url)` (or `new LocalStore().verify(key, exp, sig)`), and streams the file from the returned absolute path. Verification is constant-time, refuses expired tokens, and refuses any path that resolves outside the asset root.
- `publish` is not available locally.

### Thumbnails and probes

Ingest (`packages/core/src/assets/ingest.ts`) never fails for a missing helper:

- mime: magic bytes for png, jpeg, gif, webp, avif, mp4/mov (ftyp brands), webm (EBML), pdf, zip; then the extension; then `application/octet-stream`.
- image dimensions: parsed from PNG, JPEG (SOF), GIF and WebP (VP8/VP8L/VP8X) headers in pure JS.
- video and audio: `ffprobe` on PATH gives width, height and duration; absent, those columns stay null.
- image thumbnail: `sharp` (an **optional** dependency of `@relay/core`) resizes to fit 512 px and writes webp. If `sharp` did not install, no thumbnail.
- video poster: `ffmpeg` on PATH grabs a frame at 1 s (first frame for shorter clips) as jpeg, 512 px wide.
- HTML bundles: a zip is kind `html` only when its central directory holds `index.html` at the root or inside a single top-level folder (`site/index.html`); otherwise it is kind `file`. A bare `.html` file is also kind `html` (mime `text/html`). The app serves both in a sandboxed iframe. Zip64 archives are rejected.

Bytes are read fully into memory for hashing and sniffing; this is fine for the clips and renders agents make, not for multi-gigabyte masters.

### Retention

Rejected and superseded versions get `expires_at = now() + RELAY_ASSET_RETENTION_DAYS` (default 30). Approved and published assets have no expiry. `relay asset expire` lists what is due; `relay asset expire --yes` deletes the rows first, then the bytes, so a failed blob delete can only leave an orphan object, never a row pointing at nothing. A thumbnail key still referenced by another row is kept.

## Data

```sql
CREATE TABLE IF NOT EXISTS assets (
  id text PRIMARY KEY,               -- ulid
  project text REFERENCES projects(slug) ON DELETE SET NULL,
  issue int,
  pr int,
  title text NOT NULL,
  description text,
  kind text NOT NULL,                -- image | video | audio | pdf | html | file
  mime text NOT NULL,
  size bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,         -- blob pathname or local relative path
  thumb_key text,
  width int, height int, duration_ms int,
  version int NOT NULL DEFAULT 1,
  parent_id text REFERENCES assets(id) ON DELETE SET NULL,   -- previous version
  status text NOT NULL DEFAULT 'pending', -- pending | approved | rejected | superseded | published
  created_by text NOT NULL,          -- actor, e.g. bot:grok, runner:mini, human:kyle
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  public_url text,                   -- set only after an explicit publish
  expires_at timestamptz,            -- set when rejected or superseded
  tags text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS assets_project_status_idx ON assets(project, status, created_at DESC);
CREATE INDEX IF NOT EXISTS assets_expires_idx ON assets(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_parent_idx ON assets(parent_id);
```

There are no per-row grants; access is enforced by the app's API scopes. `parent_id` is `ON DELETE SET NULL` so expiring an old version never cascades into the current one.

## Module API

`packages/core/src/db/assets.ts` (also reachable as `repo.*`):

| function | does |
|---|---|
| `createAsset(db, input)` | insert version 1 (bytes must already be in the store); writes `asset.uploaded` |
| `getAsset(db, id)` | one row or undefined |
| `listAssets(db, { project?, status?, kind?, issue?, pr?, limit? })` | pending first, then newest first |
| `listVersions(db, id)` | the whole version chain of the asset `id` belongs to, oldest first |
| `newVersion(db, parentId, input)` | insert version n+1 inheriting project/issue/pr/title/description/tags unless given; parent becomes `superseded` with an expiry; writes `asset.uploaded` |
| `reviewAsset(db, id, { decision: 'approved' \| 'rejected', by, note? })` | sets status, reviewer, note; rejected rows get an expiry; writes `asset.reviewed` (note in `summary`); a rejection note is also an `addDecision` with `source: 'review'`, `source_ref: <asset id>` |
| `publishAsset(db, id, publicUrl, { by? })` | status `published`, clears expiry, writes `asset.published` with `url` |
| `listExpiredAssets(db, now?)` | dry run of the retention sweep |
| `expireAssets(db, now?)` | deletes due rows, returns `{ id, keys }[]` for the caller to remove from the store |
| `retentionDays()` | `RELAY_ASSET_RETENTION_DAYS` or 30 |

`packages/core/src/assets/`:

| function | does |
|---|---|
| `openAssetStore({ root? })` | `BlobStore` when `BLOB_READ_WRITE_TOKEN` is set, else `LocalStore` |
| `new LocalStore(root?)`, `new BlobStore(token?, publicToken?)` | the adapters |
| `verifyLocalSignedUrl(url, store?, now?)` | `{ ok, key, path, exp }` or `{ ok: false, reason }` |
| `ingestFile(db, store, { path \| buffer, filename?, project, issue?, pr?, title?, description?, replaces?, createdBy, tags?, thumbSize?, log? })` | sniff, hash, measure, thumbnail, store, row (new version when `replaces`, inheriting title/issue/pr/description/tags that are left undefined; otherwise `title` defaults to the filename); removes the bytes again if the row fails |
| `probeBytes(bytes, filename)` | the sniffing step on its own: `{ mime, kind, size, sha256, width, height, durationMs, htmlIndex }` |
| `previewExpiredAssets(db, now?)`, `purgeExpiredAssets(db, store, now?)` | the retention sweep as the CLI runs it |
| `sniffMime`, `imageDimensions`, `zipEntryNames`, `htmlBundleIndex`, `kindForMime`, `safeFilename` | pure helpers in `media.ts` and `ingest.ts` |

## Events

| kind | actor | when | payload |
|---|---|---|---|
| `asset.uploaded` | `created_by` | a new asset or version lands | `asset_id, kind, mime, size, version, parent_id, sha256` |
| `asset.reviewed` | the reviewer | approve or reject; `summary` is `approved: <title>` or `rejected: <title> — <note>` | `asset_id, decision, note, version` |
| `asset.published` | the publisher (default `created_by`) | a public URL was created; `url` is set | `asset_id, public_url, version` |

All three carry `project`, `issue` and `pr` from the row. A rejection note is also written to memory as a decision for that project, source `review`, `source_ref` the asset id, text `Rejected "<title>" (v<n>): <note>`, so the next attempt sees it in its brief.

### Presigned uploads

Bytes should never pass through a model or, when a store can take them directly, through the app. Two more store
methods and one ingest helper make that possible:

| function | does |
|---|---|
| `store.getUploadUrl(key, ttlSeconds, { contentType })` | Blob: `issueSignedToken({ operations: ['put'] })` + `presignUrl({ operation: 'put', allowedContentTypes, allowOverwrite })`. Local: a `file://` URL whose token signs `upload/<key>` (so a view token can never write), with `op=put`; the app rewrites it to `PUT /api/assets/upload` |
| `store.read(key)` | the whole object (local file, or Blob `get` with `access: 'private'`) |
| `verifyLocalUploadUrl(url, store?, now?)` | the upload-side twin of `verifyLocalSignedUrl` |
| `uploadKeyFor(project, id, filename)` / `parseUploadKey(key)` | the key shape a presigned upload must use: `<project>/<id>/<safe filename>`, with a ulid in the middle |
| `finalizeFromKey(db, store, { key, project, issue?, pr?, title?, description?, replaces?, createdBy, tags? })` | after the PUT: read the object back, `probeBytes`, thumbnail, insert the row under the key's id (a new version when `replaces`). A missing or empty object throws `IngestError`; a failed insert deletes the bytes |

`readZipEntry(zip, name)` and `mimeForEntry(name)` (in `media.ts`) serve one entry of an HTML bundle at a time (stored or
deflate), so a bundle is never unpacked to disk.

## Interfaces

- CLI (`createdBy` and the reviewer default to `human:$USER`, override with `--by`):
  - `relay asset put <file> --project <slug> [--issue N] [--pr N] [--title ...] [--description ...] [--replaces <id>] [--tag a b]`
  - `relay asset ls [--project] [--status] [--kind] [-n 50]`
  - `relay asset get <id> [--ttl 3600]` prints the row, the version chain, and signed `url` / `thumb_url`
  - `relay asset review <id> --approve|--reject [--note "..."]`
  - `relay asset publish <id>` (local store, or Blob without `BLOB_PUBLIC_READ_WRITE_TOKEN`: prints why it cannot and exits 2)
  - `relay asset expire [--yes]` (dry run by default)
- HTTP (`/api/v1/assets`, in `apps/web`; every operation is in `/openapi.json`, errors are RFC 9457):
  - `GET /api/v1/assets` (`assets:read`): `listAssets` with `project`, `status`, `kind`, `issue`, `pr`, `limit`.
  - `POST /api/v1/assets` (`assets:write`): multipart `file` + metadata → `ingestFile` → `201` with the asset; or JSON
    `{ "presign": true, "project", "filename", "content_type"?, ...metadata }` → `201` with `id`, `key`, `upload_url`,
    `method: PUT`, `headers`, `expires_at`, `finalize_url`, `finalize_body`.
  - `POST /api/v1/assets/{id}/finalize` (`assets:write`): `finalizeFromKey`; `409` when already finalized, `404` when
    nothing was uploaded to the key.
  - `GET /api/v1/assets/{id}` (`assets:read`): metadata, `versions`, `task_url`, and signed `url`, `thumb_url`,
    `bundle_url` (absolute, expire after an hour).
  - `PUT /api/v1/assets/{id}/review` (`assets:review`): `{ decision, note? }`; a rejection needs a note. The reviewer,
    like the creator on upload and finalize, is always the caller (token name or signed-in login), never a body field.
  - `POST /api/v1/assets/{id}/publish` (`assets:write`): `store.publish` + `publishAsset`; `501` without a public store.
  - Local store only: `GET /api/assets/stream?key&exp&sig` streams a verified signed URL (range requests supported);
    `PUT /api/assets/upload?key&exp&sig` is the presigned upload target (200 MB cap).
  - `GET /api/assets/bundle/{id}/{exp}/{sig}/{entry}` serves one entry of an HTML bundle for the viewer's sandboxed
    iframe. The signature is app-level (HMAC over `bundle/<id>` with `RELAY_ASSET_SIGNING_KEY`, else the local
    signing key, else the Blob token) so one URL covers the whole bundle and relative links keep working.
  - `GET /api/cron/assets-expire` with `Authorization: Bearer $CRON_SECRET`: `purgeExpiredAssets`. `apps/web/vercel.json`
    schedules it daily at 04:00 UTC.
  - The app calls the module functions above; nothing in `packages/core` speaks HTTP. In mock mode (`RELAY_DATA=mock`)
    the list, get, review and publish operations work on ~7 demo assets whose bytes come from `/api/assets/mock/{id}`;
    uploads answer `501`.
- MCP tools (the shared server in `packages/mcp`, over stdio and at `/mcp`): `relay_asset_list` and `relay_asset_get`
  (`assets:read`), `relay_asset_request_upload` and `relay_asset_finalize` (`assets:write`). Over stdio the URLs are
  the store's own (`file://` locally); over HTTP the app rewrites them to its routes. Agents upload bytes to the
  returned URL; bytes never pass through the model.
- GitHub (`apps/web/lib/github.ts`): with `GITHUB_APP_TOKEN` or `GITHUB_TOKEN` set, an upload with an issue or PR
  number gets a comment with the title and the viewer link; a review gets the decision, and a rejection also reopens
  the issue (`PATCH /repos/{repo}/issues/{n}` with `state: open`). Without a token nothing is posted and nothing fails.

## Web

- `/assets`: gallery, pending first in a "Needs review" group, then grouped by project; filters by project, status and
  kind live in the URL (`listAssets`).
- `/assets/[id]`: viewer per kind (image, video with poster, PDF in an iframe, HTML in an iframe with
  `sandbox="allow-scripts"` and no `allow-same-origin`; bundles are unzipped entry by entry on demand), version strip
  (`listVersions`), approve / reject with note (`reviewAsset` through a server action), keyboard `a` / `r`
  (Cmd/Ctrl+Enter submits the note), who made it and from which task, a publish button once approved. View URLs come
  from `store.getSignedUrl` (Blob) or the app's own streaming route after `verifyLocalSignedUrl` (local). The web
  app's reviews are attributed to the signed-in GitHub user, `human:<login>` (docs/SECURITY.md); in mock mode to
  `RELAY_REVIEWER`, default `human:demo`.
- The feed home shows the pending count in its header and a "Needs review" strip above the events whenever any
  exist. Pending reviews also reach the front end (Grok Bot, iMessage) with a signed link; replying through Concierge
  calls the review route.

## Environment

| name | effect |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | selects the private Blob store |
| `BLOB_PUBLIC_READ_WRITE_TOKEN` | the public store `publish` copies into |
| `RELAY_ASSET_SIGNING_KEY` | HMAC secret for local signed URLs and bundle URLs (else `<root>/.signing-key`; Blob deployments fall back to the Blob token for bundle URLs) |
| `RELAY_ASSET_RETENTION_DAYS` | days before rejected/superseded versions expire (30) |
| `RELAY_HOME` | base folder; assets live in `$RELAY_HOME/assets/` |
| `CRON_SECRET` | what the retention cron must present to `/api/cron/assets-expire` |
| `GITHUB_APP_TOKEN` / `GITHUB_TOKEN` | enables the GitHub comments and reopen on rejection |
| `RELAY_REVIEWER` | mock mode only: actor the demo's reviews are attributed to (default `human:demo`); with a database the signed-in user is the reviewer |

## Not in scope

Annotation tools, comments pinned to coordinates, collaborative editing. Approve, reject, note, versions. That is the loop.
