import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, QueueEvents, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { cadenceRuns, createDb, users, type Db } from "@mission-control/db";
import { withCadenceRun } from "@mission-control/core";
import { createConnection } from "./queues";
import { databaseUrl, redisUrl } from "./env";

// Full queue round-trip on a throwaway queue: proves Redis connectivity and
// that a stub job leaves a succeeded cadence_runs row (MC-003 AC).
const TEST_QUEUE = "test-stub-queue";

let db: Db;
let pool: { end(): Promise<void> };
let ownerId: string;

beforeAll(async () => {
  ({ db, pool } = createDb(databaseUrl()));
  const email = "worker-test@example.com";
  await db.insert(users).values({ email, displayName: "Worker Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, email));
  ownerId = u!.id;
});

afterAll(async () => {
  await pool.end();
});

describe("worker round-trip", () => {
  it("a stub job processed through BullMQ leaves a succeeded cadence_runs row", async () => {
    const queue = new Queue(TEST_QUEUE, { connection: createConnection(redisUrl()) });
    const events = new QueueEvents(TEST_QUEUE, { connection: createConnection(redisUrl()) });
    await events.waitUntilReady();

    // BullMQ rejects ":" in custom jobIds — deterministic ids use "-" separators
    const jobId = `stub-worker-roundtrip-${Date.now()}`;
    const worker = new Worker(
      TEST_QUEUE,
      async (job) =>
        withCadenceRun(db, { ownerId, jobName: "stub_job", jobId: job.id! }, async () => "ok"),
      { connection: createConnection(redisUrl()) },
    );

    try {
      const job = await queue.add("stub", {}, { jobId });
      const result = await job.waitUntilFinished(events, 15_000);
      expect(result).toBe("ok");

      const [run] = await db.select().from(cadenceRuns).where(eq(cadenceRuns.jobId, jobId));
      expect(run?.status).toBe("succeeded");
      expect(run?.finishedAt).not.toBeNull();
    } finally {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });
});
