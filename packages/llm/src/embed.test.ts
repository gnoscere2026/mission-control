import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, modelCalls, users, type Db } from "@mission-control/db";
import { embed } from "./embed";
import type { EmbeddingAdapter } from "./types";

const OWNER_EMAIL = "llm-embed-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control",
  ));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Embed Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  await db.delete(modelCalls).where(eq(modelCalls.ownerId, ownerId));
});

function adapterReturning(embeddings: number[][], totalTokens: number): EmbeddingAdapter {
  return { embedBatch: async () => ({ embeddings, usage: { totalTokens } }) };
}

describe("embed", () => {
  it("returns embeddings and writes a cost-tracked model_calls row", async () => {
    const res = await embed({
      db, ownerId, task: "embed.memory", input: ["prefers async updates"],
      dataCategories: ["memory"], adapter: adapterReturning([[0.1, 0.2]], 1000),
    });
    expect(res.embeddings).toEqual([[0.1, 0.2]]);
    expect(res.model).toBe("voyage-3.5");
    const [row] = await db.select().from(modelCalls).where(eq(modelCalls.id, res.modelCallId));
    expect(row).toMatchObject({
      ownerId, task: "embed.memory", provider: "voyage", model: "voyage-3.5",
      tier: "embed", inputTokens: 1000, outputTokens: 0, status: "ok",
      dataCategories: ["memory"],
    });
    expect(row!.costUsd).toBe("0.000060");
  });

  it("writes a failed row and rethrows on adapter failure", async () => {
    const boom: EmbeddingAdapter = { embedBatch: async () => { throw new Error("voyage down"); } };
    await expect(
      embed({ db, ownerId, task: "embed.query", input: ["q"], dataCategories: ["memory"], adapter: boom }),
    ).rejects.toThrow("voyage down");
    const [row] = await db
      .select().from(modelCalls)
      .where(eq(modelCalls.ownerId, ownerId)).orderBy(desc(modelCalls.createdAt)).limit(1);
    expect(row).toMatchObject({ status: "failed", task: "embed.query", tier: "embed" });
    expect(row!.error).toContain("voyage down");
  });

  it("throws on unknown task before any adapter call or row", async () => {
    await expect(
      embed({ db, ownerId, task: "embed.nope", input: ["x"], dataCategories: [], adapter: adapterReturning([[1]], 1) }),
    ).rejects.toThrow(/register/);
    expect(await db.select().from(modelCalls).where(eq(modelCalls.ownerId, ownerId))).toHaveLength(0);
  });

  it("rejects empty input without a model call", async () => {
    await expect(
      embed({ db, ownerId, task: "embed.memory", input: [], dataCategories: [], adapter: adapterReturning([], 0) }),
    ).rejects.toThrow(/at least one/);
  });
});
