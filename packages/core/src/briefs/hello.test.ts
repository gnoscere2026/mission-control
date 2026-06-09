import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { briefs, contextPackets, createDb, users, type Db } from "@mission-control/db";
import { generateHelloBrief } from "./hello";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(url));
  const email = "hello-brief-test@example.com";
  await db.insert(users).values({ email, displayName: "Hello Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, email));
  ownerId = u!.id;
});

describe("generateHelloBrief", () => {
  it("creates one brief per date and converges on re-run (dedupe key)", async () => {
    const date = `test-${Date.now()}`; // unique per test run; dedupe key is text

    const first = await generateHelloBrief(db, { ownerId, date });
    expect(first.created).toBe(true);

    const second = await generateHelloBrief(db, { ownerId, date });
    expect(second.created).toBe(false);
    expect(second.briefId).toBe(first.briefId);

    const rows = await db
      .select()
      .from(briefs)
      .where(and(eq(briefs.ownerId, ownerId), eq(briefs.dedupeKey, `morning:${date}`)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("morning");
    expect(rows[0]?.contentMd).toContain(date);

    // traceability: the brief points at a persisted context packet (ARCHITECTURE §6)
    const [packet] = await db
      .select()
      .from(contextPackets)
      .where(eq(contextPackets.id, rows[0]!.contextPacketId));
    expect(packet?.task).toBe("cos.morning_brief");
    expect(packet?.ownerId).toBe(ownerId);
  });
});
