import { defineConfig } from "vitest/config";

// The pure modules under agent/lib and the fake relay the evals run against. No model is called: behavior that needs
// one is in evals/, which `eve eval` runs and this does not.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
