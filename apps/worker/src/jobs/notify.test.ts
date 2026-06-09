import { beforeAll, describe, expect, it } from "vitest";
import type { Job } from "bullmq";
import { desc, eq } from "drizzle-orm";
import { briefs, cadenceRuns, createDb, pushSubscriptions, runSteps, users, type Db } from "@mission-control/db";
import { generateHelloBrief } from "@mission-control/core";
import { makeNotifyProcessor } from "./notify";
import type { JobContext } from "./index";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

let db: Db;
let ctx: JobContext;

function fakeJob(briefId: string, suffix: string): Job {
  return {
    name: "deliver_brief",
    id: `notify-test-${suffix}`,
    data: { briefId },
    attemptsMade: 0,
  } as unknown as Job;
}

beforeAll(async () => {
  ({ db } = createDb(url));
  const email = "notify-test@example.com";
  await db.insert(users).values({ email, displayName: "Notify Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, email));
  // queues unused by the notify processor
  ctx = { db, owner: { id: u!.id, email, displayName: "Notify Test" }, queues: {} as never };
});

async function makeBrief(suffix: string): Promise<string> {
  const { briefId } = await generateHelloBrief(db, {
    ownerId: ctx.owner.id,
    date: `notify-${suffix}-${Date.now()}`,
  });
  return briefId;
}

describe("notify processor", () => {
  it("sends the email mirror and sets emailed_at once", async () => {
    const sent: { subject: string; text: string }[] = [];
    const processor = makeNotifyProcessor(ctx, {
      email: { send: async (m) => void sent.push(m) },
    });
    const briefId = await makeBrief("ok");

    await processor(fakeJob(briefId, `ok-${Date.now()}`), undefined as never);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain("Morning Brief");
    const [brief] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(brief?.emailedAt).not.toBeNull();
  });

  it("push success sets pushed_at and records per-channel run steps", async () => {
    await db
      .insert(pushSubscriptions)
      .values({ ownerId: ctx.owner.id, endpoint: `https://push.example/notify-${Date.now()}`, p256dh: "p", auth: "a" })
      .onConflictDoNothing();
    const processor = makeNotifyProcessor(ctx, {
      email: { send: async () => undefined },
      push: { send: async () => undefined },
    });
    const briefId = await makeBrief("push");
    const jobId = `push-ok-${Date.now()}`;

    const result = (await processor(fakeJob(briefId, jobId), undefined as never)) as {
      emailed: boolean;
      pushed: boolean;
    };
    expect(result.pushed).toBe(true);

    const [brief] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(brief?.pushedAt).not.toBeNull();
    expect(brief?.emailedAt).not.toBeNull();

    // per-channel visibility: email + push steps under the run (invariant 7)
    const [run] = await db
      .select()
      .from(cadenceRuns)
      .where(eq(cadenceRuns.jobId, `notify-test-${jobId}`));
    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, run!.id));
    expect(steps.map((s) => `${s.name}:${s.status}`).sort()).toEqual(["email:ok", "push:ok"]);
  });

  it("SMTP failure → failed cadence_runs row, error propagated (no swallowing)", async () => {
    const processor = makeNotifyProcessor(ctx, {
      email: {
        send: async () => {
          throw new Error("SMTP connection refused");
        },
      },
    });
    const briefId = await makeBrief("fail");
    const jobId = `fail-${Date.now()}`;

    await expect(processor(fakeJob(briefId, jobId), undefined as never)).rejects.toThrow(
      "SMTP connection refused",
    );

    const [run] = await db
      .select()
      .from(cadenceRuns)
      .where(eq(cadenceRuns.jobId, `notify-test-${jobId}`))
      .orderBy(desc(cadenceRuns.startedAt));
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("SMTP connection refused");

    const [brief] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(brief?.emailedAt).toBeNull();
  });
});
