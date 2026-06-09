import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { cadenceRuns, createDb, users, type Db } from "@mission-control/db";
import { withCadenceRun } from "./cadence-runs";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(url));
  const email = "cadence-run-test@example.com";
  await db.insert(users).values({ email, displayName: "Cadence Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, email));
  ownerId = u!.id;
});

describe("withCadenceRun", () => {
  it("brackets a successful job: running → succeeded with finished_at", async () => {
    const result = await withCadenceRun(
      db,
      { ownerId, jobName: "stub_job", jobId: "stub:success-1" },
      async (runId) => {
        // mid-flight the row must exist and be running
        const [mid] = await db.select().from(cadenceRuns).where(eq(cadenceRuns.id, runId));
        expect(mid?.status).toBe("running");
        expect(mid?.jobName).toBe("stub_job");
        return "done";
      },
    );
    expect(result).toBe("done");

    const [row] = await db
      .select()
      .from(cadenceRuns)
      .where(eq(cadenceRuns.jobId, "stub:success-1"));
    expect(row?.status).toBe("succeeded");
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.error).toBeNull();
  });

  it("brackets a thrown error: running → failed with error text, and rethrows", async () => {
    await expect(
      withCadenceRun(db, { ownerId, jobName: "stub_job", jobId: "stub:fail-1" }, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");

    const [row] = await db.select().from(cadenceRuns).where(eq(cadenceRuns.jobId, "stub:fail-1"));
    expect(row?.status).toBe("failed");
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.error).toContain("kaboom");
  });
});
