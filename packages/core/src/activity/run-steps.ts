import { runSteps, type Db } from "@mission-control/db";

// Append-only step records under a cadence run (invariant 2). Phase 0 uses
// these for per-channel delivery outcomes (email vs push — degraded delivery
// is recorded, not swallowed).
export interface AppendRunStepArgs {
  runId: string;
  seq: number;
  name: string;
  status: "ok" | "failed" | "skipped";
  startedAt: Date;
  finishedAt?: Date;
  detail?: unknown;
}

export async function appendRunStep(db: Db, args: AppendRunStepArgs): Promise<void> {
  await db.insert(runSteps).values({
    runId: args.runId,
    seq: args.seq,
    name: args.name,
    status: args.status,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt ?? new Date(),
    ...(args.detail !== undefined ? { detail: args.detail } : {}),
  });
}
