import type { Queues } from "./queues";

// Repeatable-job registry (ARCHITECTURE §5.1). Crons are America/Denver.
// MC-005 adds the morning-brief tick; later phases add ingest/reconciliation/EOD/weekly.
export async function registerSchedulers(_queues: Queues): Promise<string[]> {
  const registered: string[] = [];
  return registered;
}
