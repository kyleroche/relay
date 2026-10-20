-- The asset a task delivered, cached on the task row (docs/ARCHITECTURE.md "A task's life", the asset path). A
-- production task ends in a media asset on the issue rather than a pull request: `asset.uploaded` puts it in review,
-- `asset.reviewed` approves (done) or rejects (queued) it. The fold in db/tasks.ts (deriveTaskStatus) carries the
-- latest asset as `asset`; refreshTaskState (db/task-state.ts) writes it here, with the thumbnail key from the assets
-- row, so the board draws the card from one query. Additive; the migration runner refolds every task once it lands.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS asset_id text;           -- assets.id of the latest asset.uploaded on the issue
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS asset_kind text;         -- image | video | audio | pdf | html | file
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS asset_version integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS asset_thumb_key text;    -- assets.thumb_key, null when the store rendered none (audio)
