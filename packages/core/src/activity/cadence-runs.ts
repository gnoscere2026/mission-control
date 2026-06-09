import { and, eq } from "drizzle-orm";
import { cadenceRuns, type Db } from "@mission-control/db";

// Activity log, invariant 2 (CLAUDE.md): cadence_runs is append-only except the
// once-only lifecycle close (status, finished_at, error) written here. These are
// the ONLY writers for cadence_runs — jobs never touch the table directly.

export interface OpenCadenceRunArgs {
  ownerId: string;
  jobName: string;
  jobId: string;
  attempt?: number;
  agentKey?: string;
  meta?: unknown;
}

export async function openCadenceRun(db: Db, args: OpenCadenceRunArgs): Promise<string> {
  const [row] = await db
    .insert(cadenceRuns)
    .values({
      ownerId: args.ownerId,
      jobName: args.jobName,
      jobId: args.jobId,
      attempt: args.attempt ?? 1,
      ...(args.agentKey ? { agentKey: args.agentKey } : {}),
      ...(args.meta !== undefined ? { meta: args.meta } : {}),
    })
    .returning({ id: cadenceRuns.id });
  if (!row) throw new Error("openCadenceRun: insert returned no row");
  return row.id;
}

// Once-only: the WHERE status='running' guard makes a second close a no-op,
// so the lifecycle columns transition exactly once.
export async function closeCadenceRun(
  db: Db,
  runId: string,
  outcome: "succeeded" | "failed",
  error?: string,
): Promise<void> {
  await db
    .update(cadenceRuns)
    .set({ status: outcome, finishedAt: new Date(), error: error ?? null })
    .where(and(eq(cadenceRuns.id, runId), eq(cadenceRuns.status, "running")));
}

export async function withCadenceRun<T>(
  db: Db,
  args: OpenCadenceRunArgs,
  fn: (runId: string) => Promise<T>,
): Promise<T> {
  const runId = await openCadenceRun(db, args);
  try {
    const result = await fn(runId);
    await closeCadenceRun(db, runId, "succeeded");
    return result;
  } catch (err) {
    await closeCadenceRun(db, runId, "failed", err instanceof Error ? err.message : String(err));
    throw err;
  }
}
