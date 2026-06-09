import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { cadenceRuns, createDb, runSteps, users, type Db } from "@mission-control/db";
import { anyLatestRunFailed, latestRunPerJob } from "./queries";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

const OWNER_EMAIL = "web-runs-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(url));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Runs Test" }).onConflictDoNothing();
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

async function seedRun(jobName: string, status: string, startedAt: Date) {
  await db.insert(cadenceRuns).values({
    ownerId,
    jobName,
    jobId: `${jobName}-${startedAt.getTime()}`,
    status,
    startedAt,
    finishedAt: startedAt,
  });
}

describe("latestRunPerJob", () => {
  it("returns exactly the newest run for each job", async () => {
    await seedRun("ingest_gmail", "failed", new Date("2026-06-08T10:00:00Z"));
    await seedRun("ingest_gmail", "succeeded", new Date("2026-06-08T11:00:00Z"));
    await seedRun("morning_brief", "succeeded", new Date("2026-06-08T07:00:00Z"));
    await seedRun("morning_brief", "failed", new Date("2026-06-08T07:30:00Z"));

    const latest = await latestRunPerJob(db, ownerId);
    expect(latest).toHaveLength(2);
    const byJob = Object.fromEntries(latest.map((r) => [r.jobName, r.status]));
    expect(byJob).toEqual({ ingest_gmail: "succeeded", morning_brief: "failed" });
  });
});

describe("anyLatestRunFailed", () => {
  it("true only when the LATEST run of some job failed", async () => {
    await seedRun("ingest_gmail", "failed", new Date("2026-06-08T10:00:00Z"));
    await seedRun("ingest_gmail", "succeeded", new Date("2026-06-08T11:00:00Z"));
    expect(await anyLatestRunFailed(db, ownerId)).toBe(false);

    await seedRun("notify", "failed", new Date("2026-06-08T12:00:00Z"));
    expect(await anyLatestRunFailed(db, ownerId)).toBe(true);
  });
});
