import type { Processor } from "bullmq";
import type { Db } from "@mission-control/db";
import type { Owner } from "../owner";
import type { QueueName, Queues } from "../queues";
import { makeBriefsProcessor } from "./briefs";
import { makeNotifyProcessor } from "./notify";

export interface JobContext {
  db: Db;
  queues: Queues;
  owner: Owner;
}

// ingest/extraction/reconciliation get handlers in Phase 1+. An unhandled job
// failing loudly beats a silent no-op (invariant 7).
export function makeProcessor(name: QueueName, ctx: JobContext): Processor {
  switch (name) {
    case "briefs":
      return makeBriefsProcessor(ctx);
    case "notify":
      return makeNotifyProcessor(ctx);
    default:
      return async (job) => {
        throw new Error(`queue "${name}" has no handler yet (job ${job.id ?? job.name})`);
      };
  }
}
