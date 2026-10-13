# Assets: media that is too large to share, with a review loop

Agents produce things that are not code: a short film from a cloud agent, a UX mockup, a rendered page, a storyboard. The asset library stores them privately, versions them, and gives a human an approve-or-reject path that writes back to the task and to memory. It is the visual counterpart of a pull request.

## Storage

- Production: Vercel Blob, **private** access. Viewing goes through short-lived signed URLs minted by the app; nothing is public unless explicitly published.
- Local development and tests: a folder under `~/.harness/assets/` behind the same `AssetStore` interface, so a fresh clone needs no account.
- Thumbnails: generated on upload for images (resized) and video (poster frame when ffmpeg is present, else none). HTML bundles are stored as zip and served in a sandboxed iframe.
- Retention: rejected and superseded versions expire after `RELAY_ASSET_RETENTION_DAYS` (default 30). Approved assets persist.

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
  parent_id text REFERENCES assets(id),   -- previous version
  status text NOT NULL DEFAULT 'pending', -- pending | approved | rejected | superseded | published
  created_by text NOT NULL,          -- actor, e.g. bot:grok, runner:mini, human:kyle
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  public_url text,                   -- set only after an explicit publish
  expires_at timestamptz,
  tags text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS assets_project_status_idx ON assets(project, status, created_at DESC);
```

## Events

| kind | when |
|---|---|
| `asset.uploaded` | a new asset or version lands |
| `asset.reviewed` | approve or reject, with the note in `summary` |
| `asset.published` | a public URL was created |

A rejection note is also written to memory as a decision for that project, source `review`, so the next attempt sees it in its brief.

## Interfaces

- CLI: `relay asset put <file> --project <slug> [--issue N] [--title ...] [--replaces <id>]`, `relay asset ls`, `relay asset review <id> --approve|--reject --note "..."`, `relay asset publish <id>`.
- HTTP (`/api/v1/assets`): `POST` returns a one-time upload URL and asset id (`assets:write` scope); `PUT /:id/review` (`assets:review`); `GET /:id` returns metadata and a signed view URL (`assets:read`). All errors RFC 9457.
- MCP tools: `relay_asset_request_upload`, `relay_asset_get`, `relay_asset_list`. Agents upload bytes to the returned URL; bytes never pass through the model.
- GitHub: on upload with an issue or PR number, the app comments with the asset title and a signed link; on review, it comments the decision and, for a rejection, reopens the issue with the note.

## Web

- `/assets`: gallery grouped by project, filter by status and kind, pending first.
- `/assets/[id]`: viewer per kind (image, video with poster, PDF, sandboxed HTML), version strip, approve / reject with note, keyboard `a` / `r`, who made it and from which task.
- Pending reviews surface on the feed home and through the front end (Grok Bot, iMessage) with a signed link; replying through Woodhouse calls the review route.

## Not in scope

Annotation tools, comments pinned to coordinates, collaborative editing. Approve, reject, note, versions. That is the loop.
