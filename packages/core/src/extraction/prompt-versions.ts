import { promptVersions, type Db } from "@mission-control/db";
import { ACTIVE_EXTRACTION } from "./active";

// Idempotent registration of the active prompt version (MC-104): until the
// eval harness activates with numbers (EVAL-SPEC §5.3), the row carries the
// content hash so production candidates are attributable. Called at worker
// startup; eval activation later fills the eval_* fields via eval:activate.
export async function recordPromptVersion(db: Db): Promise<void> {
  await db
    .insert(promptVersions)
    .values({
      task: ACTIVE_EXTRACTION.task,
      version: ACTIVE_EXTRACTION.version,
      contentHash: ACTIVE_EXTRACTION.contentHash(),
    })
    .onConflictDoNothing();
}
