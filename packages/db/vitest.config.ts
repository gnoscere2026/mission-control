import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // DB integration tests run sequentially against one local Postgres
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
