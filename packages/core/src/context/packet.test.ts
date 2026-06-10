import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  calendarEvents, commitments, contextPackets, episodes, memories, modelCalls,
  people, userActions, users, type Db, createDb,
} from "@mission-control/db";
import type { embed } from "@mission-control/llm";
import { assembleContextPacket, estimateTokens, PACKET_TOKEN_BUDGET } from "./packet";

const OWNER_EMAIL = "core-context-test@example.com";
let db: Db;
let ownerId: string;
const NOW = new Date("2026-06-09T13:00:00Z"); // 7:00 AM Denver
const DATE = "2026-06-09";
const QUERY = new Array(1024).fill(0);

// fakeEmbed: deterministic query vector, no model_calls row needed for assembly tests
function fakeEmbed(args: Parameters<typeof embed>[0]): ReturnType<typeof embed> {
  return Promise.resolve({
    embeddings: args.input.map(() => QUERY),
    model: "voyage-3.5",
    modelCallId: "00000000-0000-0000-0000-000000000000",
    costUsd: "0",
    latencyMs: 1,
  });
}
const fakeEmbedImpl = fakeEmbed as unknown as typeof embed;

beforeAll(async () => {
  ({ db } = createDb(
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control",
  ));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Context Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  // FK order: commitments references people and episodes,
  // memories references episodes — delete dependents first.
  await db.delete(contextPackets).where(eq(contextPackets.ownerId, ownerId));
  await db.delete(commitments).where(eq(commitments.ownerId, ownerId));
  await db.delete(memories).where(eq(memories.ownerId, ownerId));
  await db.delete(calendarEvents).where(eq(calendarEvents.ownerId, ownerId));
  await db.delete(episodes).where(eq(episodes.ownerId, ownerId));
  await db.delete(userActions).where(eq(userActions.ownerId, ownerId));
  await db.delete(modelCalls).where(eq(modelCalls.ownerId, ownerId));
  await db.delete(people).where(eq(people.ownerId, ownerId));
});

describe("assembleContextPacket", () => {
  it("ranks open commitments by due date asc nulls last, then age, and includes today's schedule", async () => {
    await db.insert(commitments).values([
      { ownerId, direction: "owed_by_me", description: "no due date — oldest", sourceType: "manual", status: "open", createdAt: new Date("2026-06-01T00:00:00Z") },
      { ownerId, direction: "owed_by_me", description: "due tomorrow", sourceType: "manual", status: "open", dueDate: "2026-06-10", createdAt: new Date("2026-06-08T00:00:00Z") },
      { ownerId, direction: "owed_by_me", description: "due today", sourceType: "manual", status: "open", dueDate: "2026-06-09", createdAt: new Date("2026-06-08T00:00:00Z") },
      { ownerId, direction: "owed_by_me", description: "candidate — excluded", sourceType: "manual", status: "candidate" },
      { ownerId, direction: "owed_by_me", description: "overdue", sourceType: "manual", status: "open", dueDate: "2026-06-05", createdAt: new Date("2026-06-08T00:00:00Z") },
    ]);
    await db.insert(calendarEvents).values([
      { ownerId, gcalEventId: "ev-today", title: "Standup", startsAt: new Date("2026-06-09T15:00:00Z"), endsAt: new Date("2026-06-09T15:30:00Z") },
      { ownerId, gcalEventId: "ev-tomorrow", title: "Future", startsAt: new Date("2026-06-10T15:00:00Z") },
      { ownerId, gcalEventId: "ev-cancelled", title: "Gone", startsAt: new Date("2026-06-09T17:00:00Z"), status: "cancelled" },
    ]);

    const { packet } = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, embedImpl: fakeEmbedImpl });
    expect(packet.commitments.map((c) => c.description)).toEqual([
      "overdue", "due today", "due tomorrow", "no due date — oldest",
    ]);
    expect(packet.commitments[0]!.overdue).toBe(true);
    expect(packet.commitments[1]!.overdue).toBe(false);
    expect(packet.schedule.map((s) => s.title)).toEqual(["Standup"]);
  });

  it("is byte-identical for identical inputs (determinism)", async () => {
    await db.insert(commitments).values({ ownerId, direction: "owed_by_me", description: "d", sourceType: "manual", status: "open" });
    const a = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, embedImpl: fakeEmbedImpl });
    const b = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, embedImpl: fakeEmbedImpl });
    expect(JSON.stringify(a.packet)).toBe(JSON.stringify(b.packet));
  });

  it("persists the packet row exactly as returned", async () => {
    const { packetId, packet } = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, embedImpl: fakeEmbedImpl });
    const [row] = await db.select().from(contextPackets).where(eq(contextPackets.id, packetId));
    expect(row).toMatchObject({ ownerId, task: "cos.morning_brief" });
    // JSONB round-trip may reorder keys; compare parsed objects for deep equality
    expect(row!.content).toEqual(packet);
  });

  it("truncates episodes first, then non-pinned memories, never pinned, and records truncations", async () => {
    // 200 fat episodes guarantee the budget is blown (each summary ~2000 chars;
    // 30 × 2000 chars / 4 chars-per-token ≈ 15 000 tokens >> PACKET_TOKEN_BUDGET)
    const fat = "x".repeat(2000);
    await db.insert(episodes).values(
      Array.from({ length: 200 }, (_, i) => ({
        ownerId, occurredAt: new Date(NOW.getTime() - i * 60_000),
        type: "email_received", source: "gmail", summary: `${i} ${fat}`,
      })),
    );
    await db.insert(memories).values({ ownerId, content: "pinned goal", pinned: true, source: "manual_pin", embeddingModel: "voyage-3.5" });

    const { packet } = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, embedImpl: fakeEmbedImpl });
    expect(estimateTokens(packet)).toBeLessThanOrEqual(PACKET_TOKEN_BUDGET);
    expect(packet.meta.truncations.length).toBeGreaterThan(0);
    expect(packet.meta.truncations[0]).toMatch(/recentEpisodes/);
    expect(packet.memories.map((m) => m.content)).toContain("pinned goal");
    // newest episodes survive
    expect(packet.recentEpisodes[0]!.summary).toMatch(/^0 /);
  });

  it("flags staleSync in meta when asked", async () => {
    const { packet } = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, staleSync: true, embedImpl: fakeEmbedImpl });
    expect(packet.meta.staleSync).toBe(true);
  });
});
