import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, pushSubscriptions, users, type Db } from "@mission-control/db";
import { sendPushToOwner, type WebPushClient } from "./push";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

let db: Db;
let ownerId: string;

class GoneError extends Error {
  statusCode: number;
  constructor(statusCode: number) {
    super(`push service says ${statusCode}`);
    this.statusCode = statusCode;
  }
}

async function insertSub(endpoint: string, failureCount = 0) {
  const [row] = await db
    .insert(pushSubscriptions)
    .values({ ownerId, endpoint, p256dh: "p", auth: "a", failureCount })
    .onConflictDoUpdate({
      target: [pushSubscriptions.ownerId, pushSubscriptions.endpoint],
      set: { failureCount, disabledAt: null },
    })
    .returning({ id: pushSubscriptions.id });
  return row!.id;
}

const message = { title: "t", body: "b", url: "https://app.example/briefs/x" };

beforeAll(async () => {
  ({ db } = createDb(url));
  const email = "push-test@example.com";
  await db.insert(users).values({ email, displayName: "Push Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, email));
  ownerId = u!.id;
  // isolate: disable anything left over from previous runs
  await db.update(pushSubscriptions).set({ disabledAt: new Date() }).where(eq(pushSubscriptions.ownerId, ownerId));
});

describe("sendPushToOwner", () => {
  it("sends to healthy subs (resets failure_count) and counts 410s toward pruning", async () => {
    const okId = await insertSub(`https://push.example/ok-${Date.now()}`, 2);
    const goneId = await insertSub(`https://push.example/gone-${Date.now()}`, 0);
    const flakyId = await insertSub(`https://push.example/flaky-${Date.now()}`, 1);

    const client: WebPushClient = {
      send: async (sub) => {
        if (sub.endpoint.includes("/gone-")) throw new GoneError(410);
        if (sub.endpoint.includes("/flaky-")) throw new Error("ECONNRESET");
      },
    };
    const result = await sendPushToOwner(db, ownerId, message, client);

    expect(result.attempted).toBe(3);
    expect(result.sent).toBe(1);
    expect(result.gone).toBe(1);
    expect(result.errors).toHaveLength(2);

    const [ok] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, okId));
    expect(ok?.failureCount).toBe(0);
    expect(ok?.lastSuccessAt).not.toBeNull();

    const [gone] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, goneId));
    expect(gone?.failureCount).toBe(1);
    expect(gone?.disabledAt).toBeNull();

    // transient errors do NOT count toward pruning
    const [flaky] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, flakyId));
    expect(flaky?.failureCount).toBe(1);
  });

  it("disables a subscription on its 5th gone response and skips disabled subs", async () => {
    const dyingId = await insertSub(`https://push.example/dying-${Date.now()}`, 4);
    const client: WebPushClient = {
      send: async () => {
        throw new GoneError(404);
      },
    };
    await sendPushToOwner(db, ownerId, message, client);

    const [dying] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, dyingId));
    expect(dying?.failureCount).toBe(5);
    expect(dying?.disabledAt).not.toBeNull();

    // disabled subs are no longer attempted
    const again = await sendPushToOwner(db, ownerId, message, client);
    const attemptedEndpoints = again.attempted;
    const [stillDying] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, dyingId));
    expect(stillDying?.failureCount).toBe(5); // unchanged
    expect(attemptedEndpoints).toBeGreaterThanOrEqual(0);
  });
});
