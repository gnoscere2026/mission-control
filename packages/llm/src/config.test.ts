import { describe, expect, it } from "vitest";
import { computeCostUsd, resolveTask, TIER_MODELS } from "./config";

describe("resolveTask", () => {
  it("maps cos.extract_commitments to the cheap tier", () => {
    expect(resolveTask("cos.extract_commitments")).toEqual({
      tier: "cheap",
      provider: "anthropic",
      model: TIER_MODELS.cheap.model,
    });
  });

  it("throws on an unknown task — tasks must be registered, never defaulted", () => {
    expect(() => resolveTask("cos.not_a_task")).toThrow(/unknown LLM task/);
  });
});

describe("computeCostUsd", () => {
  it("haiku: 1000 in / 500 out → $0.003500", () => {
    expect(
      computeCostUsd("claude-haiku-4-5", { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 }),
    ).toBe("0.003500");
  });

  it("counts cache reads at the discounted rate", () => {
    // 10k cache-read tokens at $0.10/MTok = $0.001
    expect(
      computeCostUsd("claude-haiku-4-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 10_000 }),
    ).toBe("0.001000");
  });

  it("throws on a model missing from the price table", () => {
    expect(() =>
      computeCostUsd("gpt-99", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }),
    ).toThrow(/price table/);
  });
});
