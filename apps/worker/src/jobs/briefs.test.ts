import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { Job } from "bullmq";
import {
  cadenceRuns,
  createDb,
  googleAccounts,
  runSteps,
  users,
  type Db,
} from "@mission-control/db";
import { upsertGoogleAccount, GOOGLE_SCOPES } from "@mission-control/core";
import sodium from "libsodium-wrappers";
import { makeBriefsProcessor, type BriefsDeps } from "./briefs";
import type { JobContext } from "./index";
import type { Queues } from "../queues";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

const OWNER_EMAIL = "worker-briefs-test@example.com";
let db: Db;
let ownerId: string;
let sealKey: string;

// Track notify queue adds
const notifyAdded: { name: string; data: unknown; opts: unknown }[] = [];

function fakeQueues(): Queues {
  const mkNoop = () =>
    ({
      add: async () => undefined,
      getJob: async () => undefined,
    }) as unknown as Queues[keyof Queues];

  const notifyQueue = {
    add: async (name: string, data: unknown, opts: unknown) => {
      notifyAdded.push({ name, data, opts });
    },
    getJob: async () => undefined,
  } as unknown as Queues[keyof Queues];

  const extractionQueue = {
    add: async () => undefined,
    getJob: async () => undefined,
  } as unknown as Queues[keyof Queues];

  return {
    ingest: mkNoop(),
    extraction: extractionQueue,
    reconciliation: mkNoop(),
    briefs: mkNoop(),
    notify: notifyQueue,
  };
}

function fakeMorningBriefJob(): Job {
  return {
    name: "morning_brief",
    id: "morning-brief-2026-06-09",
    data: { date: "2026-06-09" },
    attemptsMade: 0,
  } as unknown as Job;
}

function ctx(): JobContext {
  return {
    db,
    queues: fakeQueues(),
    owner: { id: ownerId, email: OWNER_EMAIL, displayName: "Briefs Test" },
  };
}

beforeAll(async () => {
  ({ db } = createDb(url));
  await sodium.ready;
  sealKey = sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL);
  process.env.TOKEN_SEAL_KEY = sealKey;
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Briefs Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  notifyAdded.length = 0;
  // Clean up runs + steps
  const runs = await db
    .select({ id: cadenceRuns.id })
    .from(cadenceRuns)
    .where(eq(cadenceRuns.ownerId, ownerId));
  for (const r of runs) await db.delete(runSteps).where(eq(runSteps.runId, r.id));
  await db.delete(cadenceRuns).where(eq(cadenceRuns.ownerId, ownerId));
  await db.delete(googleAccounts).where(eq(googleAccounts.ownerId, ownerId));
});

async function latestRun(jobName: string) {
  const [run] = await db
    .select()
    .from(cadenceRuns)
    .where(and(eq(cadenceRuns.ownerId, ownerId), eq(cadenceRuns.jobName, jobName)))
    .orderBy(desc(cadenceRuns.startedAt))
    .limit(1);
  return run;
}

async function getRunStepsForJob(jobName: string) {
  const run = await latestRun(jobName);
  if (!run) return [];
  return db.select().from(runSteps).where(eq(runSteps.runId, run.id));
}

describe("morning_brief processor", () => {
  it("case 1: no google accounts — presync ok (accounts: 0), generateImpl called with staleSync=false, notify enqueued when created=true", async () => {
    const briefId = "00000000-0000-0000-0000-000000000001";
    const generateSpy = vi.fn(async () => ({ created: true, briefId }));

    const deps: BriefsDeps = {
      generateImpl: generateSpy as never,
    };
    const processor = makeBriefsProcessor(ctx(), deps);

    await processor(fakeMorningBriefJob(), undefined as never);

    // presync step: status ok, accounts: 0
    const steps = await getRunStepsForJob("morning_brief");
    const presync = steps.find((s) => s.name === "presync");
    expect(presync).toBeDefined();
    expect(presync!.status).toBe("ok");
    expect((presync!.detail as Record<string, unknown>).accounts).toBe(0);

    // generateImpl called with staleSync=false
    expect(generateSpy).toHaveBeenCalledTimes(1);
    const generateCall = generateSpy.mock.calls[0] as unknown as [unknown, { staleSync: boolean; ownerId: string; date: string }];
    expect(generateCall[1].staleSync).toBe(false);
    expect(generateCall[1].ownerId).toBe(ownerId);
    expect(generateCall[1].date).toBe("2026-06-09");

    // notify enqueued
    expect(notifyAdded).toHaveLength(1);
    expect(notifyAdded[0]!.name).toBe("deliver_brief");
    expect((notifyAdded[0]!.data as { briefId: string }).briefId).toBe(briefId);
    expect((notifyAdded[0]!.opts as { jobId: string }).jobId).toBe(`notify-${briefId}`);

    // run succeeded
    const run = await latestRun("morning_brief");
    expect(run?.status).toBe("succeeded");
  });

  it("case 2: presync failure (syncGmailImpl throws) — presync step failed, generateImpl called with staleSync=true, run succeeds", async () => {
    // Seed an active google account so syncGmailImpl gets invoked
    await upsertGoogleAccount(db, {
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

    const generateSpy = vi.fn(async () => ({ created: false, briefId: "some-brief-id" }));
    const syncGmailSpy = vi.fn(async () => {
      throw new Error("gmail connection error");
    });

    const deps: BriefsDeps = {
      generateImpl: generateSpy as never,
      syncGmailImpl: syncGmailSpy as never,
    };
    const processor = makeBriefsProcessor(ctx(), deps);

    await processor(fakeMorningBriefJob(), undefined as never);

    // presync step should be failed
    const steps = await getRunStepsForJob("morning_brief");
    const presync = steps.find((s) => s.name === "presync");
    expect(presync).toBeDefined();
    expect(presync!.status).toBe("failed");
    expect((presync!.detail as Record<string, unknown>).error).toContain("gmail connection error");

    // generateImpl still called, with staleSync=true
    expect(generateSpy).toHaveBeenCalledTimes(1);
    const generateCall = generateSpy.mock.calls[0] as unknown as [unknown, { staleSync: boolean }];
    expect(generateCall[1].staleSync).toBe(true);

    // run still succeeded (generation didn't throw)
    const run = await latestRun("morning_brief");
    expect(run?.status).toBe("succeeded");
  });

  it("case 3: generateImpl throws — run fails, no notify enqueued", async () => {
    const generateSpy = vi.fn(async () => {
      throw new Error("opus unavailable");
    });

    const deps: BriefsDeps = {
      generateImpl: generateSpy as never,
    };
    const processor = makeBriefsProcessor(ctx(), deps);

    await expect(
      processor(fakeMorningBriefJob(), undefined as never),
    ).rejects.toThrow("opus unavailable");

    // no notify enqueued
    expect(notifyAdded).toHaveLength(0);

    // run failed
    const run = await latestRun("morning_brief");
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("opus unavailable");
  });

  it("case 4: created=false (re-run) — no notify enqueued", async () => {
    const briefId = "00000000-0000-0000-0000-000000000002";
    const generateSpy = vi.fn(async () => ({ created: false, briefId }));

    const deps: BriefsDeps = {
      generateImpl: generateSpy as never,
    };
    const processor = makeBriefsProcessor(ctx(), deps);

    await processor(fakeMorningBriefJob(), undefined as never);

    // generateImpl called
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // no notify enqueued (created=false)
    expect(notifyAdded).toHaveLength(0);

    // run still succeeded
    const run = await latestRun("morning_brief");
    expect(run?.status).toBe("succeeded");
  });
});
