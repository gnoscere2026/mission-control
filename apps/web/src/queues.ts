import { Queue } from "bullmq";
import IORedis from "ioredis";

// Web enqueues, worker processes (ARCHITECTURE §4) — the web app never runs a
// BullMQ Worker; it only adds jobs (chat captures, OAuth initial syncs, retries).
type EnqueueQueueName = "ingest" | "extraction" | "briefs" | "notify";

const queues = new Map<EnqueueQueueName, Queue>();
let connection: IORedis | undefined;

function getConnection(): IORedis {
  if (!connection) {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    connection = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return connection;
}

export function getQueue(name: EnqueueQueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
    queues.set(name, q);
  }
  return q;
}

// Deterministic jobId ("-" separators — ":" is rejected by BullMQ custom ids).
export async function enqueueExtraction(episodeId: string): Promise<void> {
  await getQueue("extraction").add(
    "extract_commitments",
    { episodeId },
    { jobId: `extract-episode-${episodeId}` },
  );
}

export async function enqueueInitialGoogleSync(accountId: string): Promise<void> {
  const ingest = getQueue("ingest");
  await ingest.add(
    "ingest_gmail",
    { accountId },
    { jobId: `ingest-gmail-${accountId}-initial` },
  );
  await ingest.add(
    "ingest_gcal",
    { accountId },
    { jobId: `ingest-gcal-${accountId}-initial` },
  );
}
