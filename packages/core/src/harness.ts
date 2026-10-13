import { loadConfig, ensureHome, type HarnessConfig } from "./config.ts";
import { createGraphClient, type GraphClient } from "./graph/client.ts";
import { Ledger } from "./ledger/ledger.ts";
import type { Harness } from "./onboard/index.ts";

export interface OpenHarness extends Harness {
  cfg: HarnessConfig;
  graph: GraphClient;
  ledger: Ledger;
  close(): Promise<void>;
}

export function openHarness(cfg: HarnessConfig = loadConfig()): OpenHarness {
  ensureHome(cfg);
  const graph = createGraphClient(cfg.graph);
  const ledger = new Ledger(cfg.ledgerPath);
  return {
    cfg,
    graph,
    ledger,
    async close() {
      ledger.close();
      await graph.close();
    },
  };
}
