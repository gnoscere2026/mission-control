import { SCHEDULE_TZ } from "@mission-control/core";
import type { Queues } from "./queues";

// Repeatable-job registry (ARCHITECTURE §5.1). Crons are America/Denver.
// Phase 1+ adds ingest/reconciliation; Phase 4 adds EOD + weekly.
export async function registerSchedulers(queues: Queues): Promise<string[]> {
  await queues.briefs.upsertJobScheduler(
    "morning-brief-tick",
    { pattern: "0 7 * * *", tz: SCHEDULE_TZ },
    { name: "morning_brief_tick" },
  );
  return ["morning-brief-tick"];
}
