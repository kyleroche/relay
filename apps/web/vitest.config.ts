import path from "node:path";
import { defineConfig } from "vitest/config";

// Pure modules only (session tokens, route classification); nothing here boots Next or a database.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
