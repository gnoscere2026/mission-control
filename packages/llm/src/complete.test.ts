import { beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, modelCalls, users, type Db } from "@mission-control/db";
import { complete, LlmSchemaError } from "./complete";
import type { ProviderAdapter, StructuredCallResult } from "./types";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(url));
  const email = "llm-complete-test@example.com";
  await db.insert(users).values({ email, displayName: "LLM Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, email));
  ownerId = u!.id;
});

const OutSchema = z.object({ commitments: z.array(z.object({ description: z.string() })) });

function adapterReturning(...results: StructuredCallResult[]): ProviderAdapter & { calls: number } {
  let i = 0;
  return {
    calls: 0,
    async completeStructured() {
      this.calls++;
      const r = results[Math.min(i, results.length - 1)]!;
      i++;
      return r;
    },
  };
}

const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 };

async function latestCall() {
  const [row] = await db
    .select()
    .from(modelCalls)
    .where(eq(modelCalls.ownerId, ownerId))
    .orderBy(desc(modelCalls.createdAt))
    .limit(1);
  return row;
}

describe("complete", () => {
  it("happy path: returns parsed data and writes one cost-tracked model_calls row", async () => {
    const adapter = adapterReturning({
      toolInput: { commitments: [{ description: "send the deck" }] },
      usage,
    });
    const result = await complete({
      db,
      ownerId,
      task: "cos.extract_commitments",
      schema: OutSchema,
      prompt: "extract from: I'll send the deck",
      dataCategories: ["email"],
      promptVersion: "v1",
      adapter,
    });
    expect(result.data.commitments[0]!.description).toBe("send the deck");

    const row = await latestCall();
    expect(row).toMatchObject({
      task: "cos.extract_commitments",
      provider: "anthropic",
      tier: "cheap",
      status: "ok",
      promptVersion: "v1",
      inputTokens: 1000,
      outputTokens: 500,
      dataCategories: ["email"],
    });
    expect(row!.costUsd).toBe("0.003500");
    expect(row!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.modelCallId).toBe(row!.id);
  });

  it("schema-feedback retry: malformed then valid → schema_retry_ok with summed tokens", async () => {
    const adapter = adapterReturning(
      { toolInput: { commitments: [{ description: 42 }] }, usage },
      { toolInput: { commitments: [{ description: "fixed" }] }, usage },
    );
    const result = await complete({
      db,
      ownerId,
      task: "cos.extract_commitments",
      schema: OutSchema,
      prompt: "x",
      dataCategories: ["email"],
      adapter,
    });
    expect(result.data.commitments[0]!.description).toBe("fixed");
    expect(adapter.calls).toBe(2);

    const row = await latestCall();
    expect(row!.status).toBe("schema_retry_ok");
    expect(row!.inputTokens).toBe(2000);
    expect(row!.outputTokens).toBe(1000);
    expect(row!.costUsd).toBe("0.007000");
  });

  it("malformed twice: throws LlmSchemaError and writes a failed row (never silent)", async () => {
    const adapter = adapterReturning({ toolInput: { nope: true }, usage });
    await expect(
      complete({
        db,
        ownerId,
        task: "cos.extract_commitments",
        schema: OutSchema,
        prompt: "x",
        dataCategories: ["email"],
        adapter,
      }),
    ).rejects.toBeInstanceOf(LlmSchemaError);

    const row = await latestCall();
    expect(row!.status).toBe("failed");
    expect(row!.error).toMatch(/schema validation failed/i);
    expect(adapter.calls).toBe(2);
  });

  it("unknown task throws before any adapter call or row write", async () => {
    const adapter = adapterReturning({ toolInput: {}, usage });
    await expect(
      complete({
        db,
        ownerId,
        task: "cos.never_registered",
        schema: OutSchema,
        prompt: "x",
        dataCategories: [],
        adapter,
      }),
    ).rejects.toThrow(/unknown LLM task/);
    expect(adapter.calls).toBe(0);
  });

  it("provider error: writes a failed row then rethrows", async () => {
    const adapter: ProviderAdapter = {
      async completeStructured() {
        throw new Error("overloaded_error: try again");
      },
    };
    await expect(
      complete({
        db,
        ownerId,
        task: "cos.extract_commitments",
        schema: OutSchema,
        prompt: "x",
        dataCategories: ["email"],
        adapter,
      }),
    ).rejects.toThrow(/overloaded/);
    const row = await latestCall();
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("overloaded");
  });
});
