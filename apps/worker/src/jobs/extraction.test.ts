import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { cadenceRuns, createDb, runSteps, users, type Db } from "@mission-control/db";
import type { Job } from "bullmq";
import { makeExtractionProcessor } from "./extraction";
import type { JobContext } from "./index";
import type { Queues } from "../queues";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

const OWNER_EMAIL = "worker-extraction-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(url));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "WX Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  const runs = await db
    .select({ id: cadenceRuns.id })
    .from(cadenceRuns)
    .where(eq(cadenceRuns.ownerId, ownerId));
  for (const r of runs) await db.delete(runSteps).where(eq(runSteps.runId, r.id));
  await db.delete(cadenceRuns).where(eq(cadenceRuns.ownerId, ownerId));
});

function ctx(): JobContext {
  return {
    db,
    queues: {} as Queues,
    owner: { id: ownerId, email: OWNER_EMAIL, displayName: "WX" },
  };
}

function fakeJob(data: unknown, id: string): Job {
  return { name: "extract_commitments", data, id, attemptsMade: 0 } as unknown as Job;
}

async function latestRun() {
  const [run] = await db
    .select()
    .from(cadenceRuns)
    .where(and(eq(cadenceRuns.ownerId, ownerId), eq(cadenceRuns.jobName, "extract_commitments")))
    .orderBy(desc(cadenceRuns.startedAt))
    .limit(1);
  return run;
}

describe("extraction processor", () => {
  it("brackets the run, passes runId + episodeId to the service, records meta", async () => {
    const extractImpl = vi.fn(async () => ({ status: "done" as const, created: 2, duplicates: 0 }));
    const processor = makeExtractionProcessor(ctx(), { extractImpl });
    const result = await processor(fakeJob({ episodeId: "ep-42" }, "extract-episode-ep-42"), "t");

    expect(result).toMatchObject({ created: 2 });
    expect(extractImpl).toHaveBeenCalledTimes(1);
    const callArgs = extractImpl.mock.calls[0]! as unknown[];
    expect(callArgs[1]).toMatchObject({ ownerId, episodeId: "ep-42" });
    expect((callArgs[1] as { runId?: string }).runId).toBeTruthy();

    const run = await latestRun();
    expect(run?.status).toBe("succeeded");
    expect((run?.meta as { episodeId?: string })?.episodeId).toBe("ep-42");
  });

  it("a service failure lands a failed run with the error", async () => {
    const extractImpl = vi.fn(async () => {
      throw new Error("schema validation failed after retry: boom");
    });
    const processor = makeExtractionProcessor(ctx(), { extractImpl });
    await expect(
      processor(fakeJob({ episodeId: "ep-43" }, "extract-episode-ep-43"), "t"),
    ).rejects.toThrow(/schema validation/);

    const run = await latestRun();
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("schema validation");
  });

  it("missing episodeId fails loudly", async () => {
    const processor = makeExtractionProcessor(ctx(), {
      extractImpl: vi.fn(async () => ({ status: "done" as const, created: 0, duplicates: 0 })),
    });
    await expect(processor(fakeJob({}, "extract-bad"), "t")).rejects.toThrow(/episodeId/);
  });
});
