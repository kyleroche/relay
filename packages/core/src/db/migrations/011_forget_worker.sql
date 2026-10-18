-- Forgetting a worker (docs/WORKERS.md, "Retiring a worker"): `relay work forget <name>` and DELETE /api/v1/workers/{id}
-- remove the worker's row once it holds no live claim. Its claims stay, keyed by the worker's id, so past runs keep
-- their attribution (the run.* events carry `runner:<name>` anyway); the foreign key that cascaded the delete into
-- claims goes. A worker that registers again under the same name gets a fresh row and id.
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_worker_id_fkey;
