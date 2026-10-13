import { defineConfig } from "vitest/config";

// PGlite boots a WASM Postgres per test file; give cold starts room.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
