import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  briefs, calendarEvents, commitments, contextPackets, episodes, memories,
  modelCalls, people, userActions, users, type Db, createDb,
} from "@mission-control/db";
import type { embed } from "@mission-control/llm";
import { generateMorningBrief } from "./morning";

const OWNER_EMAIL = "core-morning-brief-test@example.com";
let db: Db;
let ownerId: string;
const DATE = "2026-06-09";
const QUERY = new Array(1024).fill(0);

// fakeEmbed: same typed pattern as packet.test.ts
function fakeEmbedFn(args: Parameters<typeof embed>[0]): ReturnType<typeof embed> {
  return Promise.resolve({
    embeddings: args.input.map(() => QUERY),
    model: "voyage-3.5",
    modelCallId: "00000000-0000-0000-0000-000000000000",
    costUsd: "0",
    latencyMs: 1,
  });
}
const fakeEmbed = fakeEmbedFn as unknown as typeof embed;

const fakeOutput = {
  headline: "Test headline.",
  top_commitments: [],
  schedule: [],
  waiting_on: [],
  slipped: [],
};

beforeAll(async () => {
  ({ db } = createDb(
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control",
  ));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Morning Brief Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  // FK order: briefs → contextPackets; commitments → people/episodes; memories → episodes
  await db.delete(briefs).where(eq(briefs.ownerId, ownerId));
  await db.delete(contextPackets).where(eq(contextPackets.ownerId, ownerId));
  await db.delete(commitments).where(eq(commitments.ownerId, ownerId));
  await db.delete(memories).where(eq(memories.ownerId, ownerId));
  await db.delete(calendarEvents).where(eq(calendarEvents.ownerId, ownerId));
  await db.delete(episodes).where(eq(episodes.ownerId, ownerId));
  await db.delete(userActions).where(eq(userActions.ownerId, ownerId));
  await db.delete(modelCalls).where(eq(modelCalls.ownerId, ownerId));
  await db.delete(people).where(eq(people.ownerId, ownerId));
});

describe("generateMorningBrief", () => {
  it("happy path: creates packet + brief with correct fields and cadenceRunId", async () => {
    const fakeComplete = vi.fn(async () => ({
      data: fakeOutput,
      modelCallId: "00000000-0000-0000-0000-000000000000",
      costUsd: "0.01",
      latencyMs: 5,
    }));
    // cadenceRunId has no FK constraint on briefs — pass any uuid
    const cadenceRunId = "11111111-1111-1111-1111-111111111111";

    const result = await generateMorningBrief(db, {
      ownerId,
      date: DATE,
      cadenceRunId,
      completeImpl: fakeComplete as never,
      embedImpl: fakeEmbed,
    });

    expect(result.created).toBe(true);
    expect(typeof result.briefId).toBe("string");

    const [brief] = await db.select().from(briefs).where(eq(briefs.id, result.briefId));
    expect(brief).toMatchObject({
      kind: "morning",
      dedupeKey: `morning:${DATE}`,
      ownerId,
      cadenceRunId,
    });
    expect(brief!.contentJson).toMatchObject({ headline: "Test headline." });
    expect(brief!.contentMd).toContain("Test headline.");

    // contextPacketId points at a real context_packets row
    const [packet] = await db.select().from(contextPackets).where(eq(contextPackets.id, brief!.contextPacketId));
    expect(packet).toBeTruthy();
    expect(packet!.ownerId).toBe(ownerId);
  });

  it("idempotency: second call returns { created: false, briefId: same } and completeImpl not called again", async () => {
    const fakeComplete = vi.fn(async () => ({
      data: fakeOutput,
      modelCallId: "00000000-0000-0000-0000-000000000000",
      costUsd: "0.01",
      latencyMs: 5,
    }));

    const first = await generateMorningBrief(db, {
      ownerId,
      date: DATE,
      completeImpl: fakeComplete as never,
      embedImpl: fakeEmbed,
    });
    expect(first.created).toBe(true);

    const second = await generateMorningBrief(db, {
      ownerId,
      date: DATE,
      completeImpl: fakeComplete as never,
      embedImpl: fakeEmbed,
    });
    expect(second).toEqual({ created: false, briefId: first.briefId });
    // completeImpl was only called once — dedupe check short-circuits before generation
    expect(fakeComplete).toHaveBeenCalledTimes(1);
  });

  it("generation failure: completeImpl rejects → generateMorningBrief rejects AND zero briefs rows", async () => {
    const boom = vi.fn(async () => {
      throw new Error("opus unavailable");
    });

    await expect(
      generateMorningBrief(db, {
        ownerId,
        date: DATE,
        completeImpl: boom as never,
        embedImpl: fakeEmbed,
      }),
    ).rejects.toThrow("opus unavailable");

    // No brief row for this owner
    const rows = await db.select().from(briefs).where(eq(briefs.ownerId, ownerId));
    expect(rows).toHaveLength(0);
  });
});
