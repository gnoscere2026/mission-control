import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { briefs, contextPackets, users, type Db, createDb } from "@mission-control/db";
import { markBriefOpened } from "./delivery";

const OWNER_EMAIL = "core-delivery-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control",
  ));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Delivery Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  // FK order: briefs before contextPackets
  await db.delete(briefs).where(eq(briefs.ownerId, ownerId));
  await db.delete(contextPackets).where(eq(contextPackets.ownerId, ownerId));
});

async function seedBrief() {
  const [packet] = await db
    .insert(contextPackets)
    .values({ ownerId, task: "cos.morning_brief", content: {} })
    .returning({ id: contextPackets.id });
  const [brief] = await db
    .insert(briefs)
    .values({
      ownerId,
      kind: "morning",
      dedupeKey: `morning:delivery-test-${Date.now()}`,
      contentJson: {},
      contentMd: "",
      contextPacketId: packet!.id,
    })
    .returning({ id: briefs.id });
  return brief!.id;
}

describe("markBriefOpened", () => {
  it("first call returns true and sets openedAt", async () => {
    const briefId = await seedBrief();
    const result = await markBriefOpened(db, ownerId, briefId);
    expect(result).toBe(true);
    const [row] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(row!.openedAt).not.toBeNull();
  });

  it("second call returns false and openedAt is unchanged", async () => {
    const briefId = await seedBrief();
    await markBriefOpened(db, ownerId, briefId);
    const [rowAfterFirst] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    const firstOpenedAt = rowAfterFirst!.openedAt;

    // Capture time between calls so we can verify the timestamp didn't advance
    await new Promise((r) => setTimeout(r, 5));

    const result = await markBriefOpened(db, ownerId, briefId);
    expect(result).toBe(false);
    const [rowAfterSecond] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(rowAfterSecond!.openedAt?.getTime()).toBe(firstOpenedAt?.getTime());
  });
});
