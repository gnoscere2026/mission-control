import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, modelCalls, pushSubscriptions, users, type Db } from "@mission-control/db";
import { dailyModelSpendUsd, listPushSubscriptions } from "./queries";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

const OWNER_EMAIL = "web-delivery-health-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(url));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Delivery Health Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  await db.delete(modelCalls).where(eq(modelCalls.ownerId, ownerId));
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.ownerId, ownerId));
});

describe("dailyModelSpendUsd", () => {
  it("sums only today's Denver-day model_calls, excluding rows from 48h ago", async () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    // Today's row — should be included
    await db.insert(modelCalls).values({
      ownerId,
      task: "cos.test",
      provider: "anthropic",
      model: "claude-3-haiku",
      tier: "cheap",
      costUsd: "0.10",
      latencyMs: 100,
      status: "ok",
      createdAt: now,
    });

    // 48h-ago row — should NOT be included
    await db.insert(modelCalls).values({
      ownerId,
      task: "cos.test",
      provider: "anthropic",
      model: "claude-3-haiku",
      tier: "cheap",
      costUsd: "5.00",
      latencyMs: 100,
      status: "ok",
      createdAt: twoDaysAgo,
    });

    const result = await dailyModelSpendUsd(db, ownerId);
    expect(result).toBe("0.10");
  });

  it("returns 0.00 when no model_calls exist today", async () => {
    const result = await dailyModelSpendUsd(db, ownerId);
    expect(result).toBe("0.00");
  });
});

describe("listPushSubscriptions", () => {
  it("returns the owner's subscriptions with failureCount/disabledAt/lastSuccessAt, newest first", async () => {
    const older = new Date("2026-06-07T10:00:00Z");
    const newer = new Date("2026-06-09T10:00:00Z");
    const disabledTime = new Date("2026-06-08T12:00:00Z");
    const lastSuccess = new Date("2026-06-08T11:00:00Z");

    await db.insert(pushSubscriptions).values({
      ownerId,
      endpoint: "https://push.example/older",
      p256dh: "p1",
      auth: "a1",
      failureCount: 3,
      disabledAt: disabledTime,
      lastSuccessAt: lastSuccess,
      createdAt: older,
    });
    await db.insert(pushSubscriptions).values({
      ownerId,
      endpoint: "https://push.example/newer",
      p256dh: "p2",
      auth: "a2",
      failureCount: 0,
      createdAt: newer,
    });

    const result = await listPushSubscriptions(db, ownerId);
    expect(result).toHaveLength(2);

    // newest first
    expect(result[0]?.endpoint).toBe("https://push.example/newer");
    expect(result[0]?.failureCount).toBe(0);
    expect(result[0]?.disabledAt).toBeNull();

    expect(result[1]?.endpoint).toBe("https://push.example/older");
    expect(result[1]?.failureCount).toBe(3);
    expect(result[1]?.disabledAt).not.toBeNull();
    expect(result[1]?.lastSuccessAt).not.toBeNull();
  });

  it("returns empty array when owner has no subscriptions", async () => {
    const result = await listPushSubscriptions(db, ownerId);
    expect(result).toHaveLength(0);
  });
});
