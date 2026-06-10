import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    include: ["src/**/*.test.ts", "app/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
