import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "packages/db/migrations/**",
      "apps/web/next-env.d.ts",
      "apps/web/public/sw.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Invariant 3 (MC-104): provider SDKs only inside packages/llm.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@anthropic-ai/*", "openai", "openai/*", "voyageai", "voyageai/*", "@google/generative-ai"],
              message: "Provider SDKs may only be imported in packages/llm (CLAUDE.md invariant 3).",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["packages/llm/**"],
    rules: { "no-restricted-imports": "off" },
  }
);
