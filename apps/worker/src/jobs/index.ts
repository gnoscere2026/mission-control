import type { Processor } from "bullmq";
import type { Db } from "@mission-control/db";
import type { Owner } from "../owner";
import type { QueueName, Queues } from "../queues";

export interface JobContext {
  db: Db;
  queues: Queues;
  owner: Owner;
}

// Phase 0 processes nothing yet — handlers land with MC-005 (briefs, notify)
// and Phase 1+ (ingest, extraction, reconciliation). An unhandled job failing
// loudly beats a silent no-op (invariant 7).
export function makeProcessor(name: QueueName, _ctx: JobContext): Processor {
  return async (job) => {
    throw new Error(`queue "${name}" has no handler yet (job ${job.id ?? job.name})`);
  };
}
