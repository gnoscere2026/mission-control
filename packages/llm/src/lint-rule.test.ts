import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

// MC-104: a planted provider-SDK import outside packages/llm must fail lint
// (invariant 3 is enforced by CI, not convention).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function restrictedImportErrors(code: string, filePath: string): Promise<number> {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports").length;
}

describe("provider-SDK import ban", () => {
  it("flags @anthropic-ai/sdk outside packages/llm", async () => {
    const n = await restrictedImportErrors(
      'import Anthropic from "@anthropic-ai/sdk";\nexport const x = Anthropic;\n',
      path.join(repoRoot, "apps/web/planted-import.ts"),
    );
    expect(n).toBeGreaterThan(0);
  });

  it("flags subpath imports like @anthropic-ai/sdk/resources", async () => {
    const n = await restrictedImportErrors(
      'import { Messages } from "@anthropic-ai/sdk/resources";\nexport const x = Messages;\n',
      path.join(repoRoot, "packages/core/planted-import.ts"),
    );
    expect(n).toBeGreaterThan(0);
  });

  it("flags other provider SDKs (openai) outside packages/llm", async () => {
    const n = await restrictedImportErrors(
      'import OpenAI from "openai";\nexport const x = OpenAI;\n',
      path.join(repoRoot, "apps/worker/planted-import.ts"),
    );
    expect(n).toBeGreaterThan(0);
  });

  it("allows provider SDKs inside packages/llm", async () => {
    const n = await restrictedImportErrors(
      'import Anthropic from "@anthropic-ai/sdk";\nexport const x = Anthropic;\n',
      path.join(repoRoot, "packages/llm/src/planted-import.ts"),
    );
    expect(n).toBe(0);
  });
});
