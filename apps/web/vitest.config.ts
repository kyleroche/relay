import path from "node:path";
import { defineConfig } from "vitest/config";

// Modules under lib/, without Next: the pure ones (session tokens, route classification), and the board surfaces on an
// in-memory board and an in-memory database.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
