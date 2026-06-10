import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, memories, modelCalls, userActions, users, type Db } from "@mission-control/db";
import type { embed } from "@mission-control/llm";
import { createMemory, retrieveMemories } from "./service";

const OWNER_EMAIL = "core-memories-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control",
  ));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Mem Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  await db.delete(memories).where(eq(memories.ownerId, ownerId));
  await db.delete(userActions).where(eq(userActions.ownerId, ownerId));
  await db.delete(modelCalls).where(eq(modelCalls.ownerId, ownerId));
});

// basis vector: 1 at index i, 0 elsewhere (1024 dims = EMBEDDING_DIMS)
function vec(i: number): number[] {
  const v = new Array(1024).fill(0);
  v[i] = 1;
  return v;
}

function fakeEmbed(v: number[]): typeof embed {
  return async (args: Parameters<typeof embed>[0]) => ({
    embeddings: args.input.map(() => v),
    model: "voyage-3.5",
    modelCallId: "00000000-0000-0000-0000-000000000000",
    costUsd: "0.000001",
    latencyMs: 1,
  });
}

describe("createMemory", () => {
  it("writes content + embedding + embedding_model and logs memory_pinned for manual pins", async () => {
    const { memoryId } = await createMemory(db, {
      ownerId, content: "Prefers async updates over meetings",
      source: "manual_pin", embedImpl: fakeEmbed(vec(3)),
    });
    const [row] = await db.select().from(memories).where(eq(memories.id, memoryId));
    expect(row).toMatchObject({
      ownerId, content: "Prefers async updates over meetings",
      embeddingModel: "voyage-3.5", source: "manual_pin", pinned: true, status: "active",
    });
    expect(row!.embedding).toHaveLength(1024);
    const [action] = await db
      .select().from(userActions)
      .where(eq(userActions.ownerId, ownerId)).orderBy(desc(userActions.createdAt)).limit(1);
    expect(action).toMatchObject({ action: "memory_pinned", entityType: "memory", entityId: memoryId });
  });

  it("system memories are not pinned and log no user action", async () => {
    await createMemory(db, { ownerId, content: "bg fact", source: "system", embedImpl: fakeEmbed(vec(1)) });
    expect(await db.select().from(userActions).where(eq(userActions.ownerId, ownerId))).toHaveLength(0);
    const [row] = await db.select().from(memories).where(eq(memories.ownerId, ownerId));
    expect(row!.pinned).toBe(false);
  });
});

describe("retrieveMemories", () => {
  async function seed(content: string, embedding: number[] | null, opts: Partial<typeof memories.$inferInsert> = {}) {
    const [row] = await db.insert(memories)
      .values({ ownerId, content, embedding, embeddingModel: "voyage-3.5", source: "system", ...opts })
      .returning({ id: memories.id });
    return row!.id;
  }

  it("ranks by cosine similarity, always includes pinned, filters non-active, touches last_used_at", async () => {
    const now = new Date("2026-06-09T13:00:00Z");
    const hit = await seed("similar memory", vec(0), { createdAt: new Date("2026-06-01T00:00:00Z") });
    await seed("orthogonal memory", vec(9), { createdAt: new Date("2026-06-01T00:00:00Z") });
    const pinned = await seed("pinned goal", vec(8), { pinned: true, status: "active" });
    const archived = await seed("archived", vec(0), { status: "archived" });

    const result = await retrieveMemories(db, { ownerId, queryEmbedding: vec(0), k: 2, now });
    const ids = result.map((r) => r.id);
    expect(ids).toContain(pinned);
    expect(ids).toContain(hit);
    expect(ids).not.toContain(archived);
    // the similar memory must outrank the orthogonal one among non-pinned results
    const nonPinned = result.filter((r) => !r.pinned).map((r) => r.id);
    expect(nonPinned[0]).toBe(hit);

    const [touched] = await db.select().from(memories).where(eq(memories.id, hit));
    expect(touched!.lastUsedAt).not.toBeNull();
    const [untouchedArchived] = await db.select().from(memories).where(eq(memories.id, archived));
    expect(untouchedArchived!.lastUsedAt).toBeNull();
    // "everything returned" includes the pinned ride-along
    const [touchedPinned] = await db.select().from(memories).where(eq(memories.id, pinned));
    expect(touchedPinned!.lastUsedAt).not.toBeNull();
  });

  it("recency breaks near-ties: same similarity, newer wins", async () => {
    const now = new Date("2026-06-09T13:00:00Z");
    const old = await seed("old equal", vec(0), { createdAt: new Date("2026-01-01T00:00:00Z") });
    const fresh = await seed("fresh equal", vec(0), { createdAt: new Date("2026-06-08T00:00:00Z") });
    const result = await retrieveMemories(db, { ownerId, queryEmbedding: vec(0), k: 2, now });
    expect(result.map((r) => r.id)).toEqual([fresh, old]);
  });
});
