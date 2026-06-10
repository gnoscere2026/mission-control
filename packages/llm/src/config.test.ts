import { describe, expect, it } from "vitest";
import { computeCostUsd, resolveEmbedTask, resolveTask, TIER_MODELS } from "./config";

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

describe("resolveEmbedTask", () => {
  it("maps embed.memory and embed.query to voyage-3.5 on the embed tier", () => {
    expect(resolveEmbedTask("embed.memory")).toEqual({
      tier: "embed",
      provider: "voyage",
      model: "voyage-3.5",
    });
    expect(resolveEmbedTask("embed.query").model).toBe("voyage-3.5");
  });

  it("throws on unregistered embed tasks", () => {
    expect(() => resolveEmbedTask("embed.unknown")).toThrow(/register/);
    expect(() => resolveEmbedTask("cos.extract_commitments")).toThrow(/register/);
  });
});

it("prices voyage-3.5 embeddings at $0.06/MTok input", () => {
  expect(computeCostUsd("voyage-3.5", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 })).toBe("0.060000");
  expect(computeCostUsd("voyage-3.5", { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0 })).toBe("0.000060");
});
