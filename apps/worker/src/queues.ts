import { Queue } from "bullmq";
import IORedis from "ioredis";

// The cadence engine's queues (ARCHITECTURE §5.1). Declared up front; Phase 0
// only processes `briefs` and `notify` — the rest get handlers in Phase 1+.
export const QUEUE_NAMES = ["ingest", "extraction", "reconciliation", "briefs", "notify"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export function createConnection(url: string): IORedis {
  // BullMQ requirement: blocking commands need maxRetriesPerRequest: null
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export type Queues = Record<QueueName, Queue>;

export function createQueues(connection: IORedis): Queues {
  const entries = QUEUE_NAMES.map((name) => [
    name,
    new Queue(name, {
      connection,
      defaultJobOptions: {
        // ARCHITECTURE §5.2: exponential backoff, 5 attempts, base 30s
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    }),
  ]);
  return Object.fromEntries(entries) as Queues;
}
