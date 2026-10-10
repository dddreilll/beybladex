import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": here("./"),
      // `server-only` throws outside React Server Components; lib code is safe to import in tests.
      "server-only": here("./tests/stubs/empty.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // Integration tests share one database.
    fileParallelism: false,
  },
});
