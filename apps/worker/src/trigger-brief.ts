// Manual trigger for the drill in docs/DEPLOY.md §7 — same jobId semantics as
// the 7 AM tick, so running this twice (or after the cron fired) is a no-op.
import { dateKeyInDenver } from "@mission-control/core";
import { loadEnv, redisUrl } from "./env";
import { createConnection, createQueues } from "./queues";

loadEnv();
const date = dateKeyInDenver();
const connection = createConnection(redisUrl());
const queues = createQueues(connection);

const jobId = `morning-brief-${date}`;
await queues.briefs.add("morning_brief", { date }, { jobId });
console.log(`enqueued morning_brief for ${date} (jobId ${jobId}) — no-op if already present`);

await Promise.allSettled(Object.values(queues).map((q) => q.close()));
await connection.quit();
