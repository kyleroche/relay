/**
 * TODO(db): Postgres adapter. Selected by lib/data.ts when DATABASE_URL is set
 * (or RELAY_DATA=db). It will call the typed queries that @relay/core's storage
 * port exposes once it lands:
 *
 *   import { listEvents }                from "@relay/core/db/events.ts";    // -> getFeed, writeEvent (via insertEvent)
 *   import { listProjects, getProject }  from "@relay/core/db/projects.ts";  // -> getProjects, getProject
 *   import { usageSummary }              from "@relay/core/db/ledger.ts";    // -> getUsage (ledger view + plan meters)
 *   import { listDecisions }             from "@relay/core/db/decisions.ts"; // -> getProject().decisions
 *   import { listModels }                from "@relay/core/db/models.ts";    // -> getModels, getProject().models
 *
 * Shapes are expected to match lib/types.ts one-to-one (they mirror schema.sql);
 * anything that drifts gets mapped here, not in pages. Until then every method
 * throws so a misconfigured deploy fails loudly instead of showing mock data.
 */
import type { DataSource } from "./types.ts";

function notWired(method: string): never {
  throw new Error(
    `relay web: database adapter is not wired yet (${method}). Unset DATABASE_URL or set RELAY_DATA=mock.`,
  );
}

export const dbSource: DataSource = {
  async getFeed() {
    return notWired("getFeed -> listEvents");
  },
  async getProjects() {
    return notWired("getProjects -> listProjects");
  },
  async getProject() {
    return notWired("getProject -> getProject + listDecisions + listModels");
  },
  async getUsage() {
    return notWired("getUsage -> usageSummary");
  },
  async getWorkers() {
    return notWired("getWorkers -> listEvents(kind: run.*) rollup");
  },
  async getModels() {
    return notWired("getModels -> listModels");
  },
  async writeEvent() {
    return notWired("writeEvent -> insertEvent");
  },
};
