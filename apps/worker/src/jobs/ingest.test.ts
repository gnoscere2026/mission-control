import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import sodium from "libsodium-wrappers";
import {
  cadenceRuns,
  createDb,
  googleAccounts,
  runSteps,
  users,
  type Db,
} from "@mission-control/db";
import { upsertGoogleAccount, GOOGLE_SCOPES, ReauthRequiredError } from "@mission-control/core";
import type { Job } from "bullmq";
import { makeIngestProcessor, type IngestDeps } from "./ingest";
import type { JobContext } from "./index";
import type { Queues } from "../queues";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

const OWNER_EMAIL = "worker-ingest-test@example.com";
let db: Db;
let ownerId: string;
let accountId: string;
let sealKey: string;

const added: { queue: string; name: string; data: unknown; opts: unknown }[] = [];
function fakeQueues(): Queues {
  const mk = (queue: string) =>
    ({
      add: async (name: string, data: unknown, opts: unknown) => {
        added.push({ queue, name, data, opts });
      },
    }) as unknown as Queues[keyof Queues];
  return {
    ingest: mk("ingest"),
    extraction: mk("extraction"),
    reconciliation: mk("reconciliation"),
    briefs: mk("briefs"),
    notify: mk("notify"),
  };
}

function fakeJob(name: string, data: unknown, id: string): Job {
  return { name, data, id, attemptsMade: 0 } as unknown as Job;
}

beforeAll(async () => {
  ({ db } = createDb(url));
  await sodium.ready;
  sealKey = sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL);
  process.env.TOKEN_SEAL_KEY = sealKey;
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "WI Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  added.length = 0;
  const runs = await db
    .select({ id: cadenceRuns.id })
    .from(cadenceRuns)
    .where(eq(cadenceRuns.ownerId, ownerId));
  for (const r of runs) await db.delete(runSteps).where(eq(runSteps.runId, r.id));
  await db.delete(cadenceRuns).where(eq(cadenceRuns.ownerId, ownerId));
  await db.delete(googleAccounts).where(eq(googleAccounts.ownerId, ownerId));
  accountId = await upsertGoogleAccount(db, {
    ownerId,
    email: OWNER_EMAIL,
    tokens: {
      access_token: "at",
      refresh_token: "rt",
      expiry_date: Date.now() + 3_600_000,
      token_type: "Bearer",
      scope: GOOGLE_SCOPES.join(" "),
    },
    sealKey,
  });
});

function ctx(): JobContext {
  return { db, queues: fakeQueues(), owner: { id: ownerId, email: OWNER_EMAIL, displayName: "WI" } };
}

async function latestRun(jobName: string) {
  const [run] = await db
    .select()
    .from(cadenceRuns)
    .where(and(eq(cadenceRuns.ownerId, ownerId), eq(cadenceRuns.jobName, jobName)))
    .orderBy(desc(cadenceRuns.startedAt))
    .limit(1);
  return run;
}

describe("ingest_tick", () => {
  it("outside working hours: skips without opening a run or enqueueing", async () => {
    const deps: IngestDeps = { now: () => new Date("2026-06-08T05:00:00-06:00") }; // 5 AM Denver
    const processor = makeIngestProcessor(ctx(), deps);
    const result = await processor(fakeJob("ingest_tick", {}, "tick-1"), "tok");
    expect(result).toMatchObject({ skipped: "outside_working_hours" });
    expect(added).toHaveLength(0);
    expect(await latestRun("ingest_tick")).toBeUndefined();
  });

  it("inside working hours: enqueues gmail+gcal per active account, brackets a run", async () => {
    const deps: IngestDeps = { now: () => new Date("2026-06-08T10:00:00-06:00") };
    const processor = makeIngestProcessor(ctx(), deps);
    await processor(fakeJob("ingest_tick", {}, "tick-2"), "tok");
    expect(added.map((a) => a.name).sort()).toEqual(["ingest_gcal", "ingest_gmail"]);
    expect((await latestRun("ingest_tick"))?.status).toBe("succeeded");
  });
});

describe("ingest_gmail", () => {
  it("happy path: syncs, records steps, enqueues extraction per new episode", async () => {
    const c = ctx();
    const deps: IngestDeps = {
      now: () => new Date("2026-06-08T10:00:00-06:00"),
      syncGmailImpl: async () => ({
        mode: "incremental" as const,
        newEpisodeIds: ["ep-1", "ep-2"],
        extractEpisodeIds: ["ep-1", "ep-2"],
        messagesSeen: 2,
        quotaUnits: 14,
      }),
    };
    const processor = makeIngestProcessor(c, deps);
    await processor(fakeJob("ingest_gmail", { accountId }, `ingest-gmail-${accountId}-x`), "tok");

    const run = await latestRun("ingest_gmail");
    expect(run?.status).toBe("succeeded");
    expect((run?.meta as { accountId?: string })?.accountId).toBe(accountId);
    const extractionAdds = added.filter((a) => a.queue === "extraction");
    expect(extractionAdds).toHaveLength(2);
    expect((extractionAdds[0]!.opts as { jobId: string }).jobId).toBe("extract-episode-ep-1");
  });

  it("already-flagged account: fails fast without sync or push alert", async () => {
    await db
      .update(googleAccounts)
      .set({ status: "reauth_required" })
      .where(eq(googleAccounts.id, accountId));
    const syncSpy = vi.fn();
    const pushSpy = vi.fn();
    const processor = makeIngestProcessor(ctx(), {
      syncGmailImpl: syncSpy as never,
      sendReauthAlert: pushSpy as never,
    });

    await expect(
      processor(fakeJob("ingest_gmail", { accountId }, "ig-ff"), "tok"),
    ).rejects.toThrow(/reauth_required/);
    expect(syncSpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
    expect((await latestRun("ingest_gmail"))?.status).toBe("failed");
    expect((await latestRun("ingest_gmail"))?.error).toContain("reauth_required");
  });

  it("fresh invalid_grant during sync: sends one push alert and fails the run", async () => {
    const pushSpy = vi.fn(async () => {});
    const processor = makeIngestProcessor(ctx(), {
      syncGmailImpl: async () => {
        throw new ReauthRequiredError(accountId, OWNER_EMAIL);
      },
      sendReauthAlert: pushSpy,
    });

    await expect(
      processor(fakeJob("ingest_gmail", { accountId }, "ig-flip"), "tok"),
    ).rejects.toThrow(/reauth_required/);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect((await latestRun("ingest_gmail"))?.status).toBe("failed");
  });
});
