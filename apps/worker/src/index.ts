import { Worker } from "bullmq";
import { createDb } from "@mission-control/db";
import { recordPromptVersion } from "@mission-control/core";
import { databaseUrl, loadEnv, redisUrl } from "./env";
import { createConnection, createQueues, QUEUE_NAMES } from "./queues";
import { resolveOwner } from "./owner";
import { makeProcessor, type JobContext } from "./jobs/index";
import { registerSchedulers } from "./schedulers";

loadEnv();

const { db, pool } = createDb(databaseUrl());
const owner = await resolveOwner(db);
// the active extraction prompt version is always registered (MC-104)
await recordPromptVersion(db);

const queueConnection = createConnection(redisUrl());
const queues = createQueues(queueConnection);
const ctx: JobContext = { db, queues, owner };

const schedulers = await registerSchedulers(queues);

// Each Worker gets its own connection — BullMQ workers hold blocking commands,
// so they must not share the queue connection.
const workers = QUEUE_NAMES.map(
  (name) => new Worker(name, makeProcessor(name, ctx), { connection: createConnection(redisUrl()) }),
);
for (const w of workers) {
  w.on("failed", (job, err) => {
    console.error(`[${w.name}] job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade}): ${err.message}`);
  });
  w.on("error", (err) => console.error(`[${w.name}] worker error:`, err));
}

console.log(
  `worker up — owner=${owner.email} queues=[${QUEUE_NAMES.join(", ")}] schedulers=[${schedulers.join(", ")}]`,
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — draining workers`);
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled(Object.values(queues).map((q) => q.close()));
  await queueConnection.quit().catch(() => undefined);
  await pool.end();
  console.log("worker shut down cleanly");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
