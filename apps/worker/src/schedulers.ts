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
  // Every 15 min; the handler gates on the working-hours preference (MC-102).
  await queues.ingest.upsertJobScheduler(
    "ingest-tick",
    { pattern: "*/15 * * * *", tz: SCHEDULE_TZ },
    { name: "ingest_tick" },
  );
  return ["morning-brief-tick", "ingest-tick"];
}
