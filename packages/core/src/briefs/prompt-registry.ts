import { promptVersions, type Db } from "@mission-control/db";
import { ACTIVE_EXTRACTION } from "../extraction/active";
import { ACTIVE_MORNING_BRIEF } from "./active";

// Worker-startup registration for every active prompt module (MC-203 extends
// MC-104's recordPromptVersion, which stays untouched — its path is eval-gated).
export async function recordActivePromptVersions(db: Db): Promise<void> {
  for (const mod of [ACTIVE_EXTRACTION, ACTIVE_MORNING_BRIEF] as const) {
    await db
      .insert(promptVersions)
      .values({ task: mod.task, version: mod.version, contentHash: mod.contentHash() })
      .onConflictDoNothing();
  }
}
