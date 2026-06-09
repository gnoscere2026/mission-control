import { describe, expect, it } from "vitest";
import { LLM_PACKAGE } from "./index";

describe("workspace wiring", () => {
  it("resolves the llm workspace", () => {
    expect(LLM_PACKAGE).toBe("@mission-control/llm");
  });
});
