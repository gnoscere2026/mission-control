// One-off smoke: insert a chat episode and run the REAL extraction path
// (real complete(), real Anthropic adapter). With a bogus ANTHROPIC_API_KEY
// this proves the failure path: failed model_calls row + failed cadence_run,
// visible on /runs. With a real key it proves the happy path end to end.
// Usage: npm run smoke:extraction -w apps/worker
import { createDb, episodes } from "@mission-control/db";
import { extractCommitmentsFromEpisode, withCadenceRun } from "@mission-control/core";
import { databaseUrl, loadEnv } from "./env";
import { resolveOwner } from "./owner";

loadEnv();
const { db, pool } = createDb(databaseUrl());
const owner = await resolveOwner(db);

const [ep] = await db
  .insert(episodes)
  .values({
    ownerId: owner.id,
    occurredAt: new Date(),
    type: "chat_message",
    source: "chat",
    summary: "smoke: told Sara I'd send the contract Friday",
    payload: { text: "told Sara I'd send the contract Friday" },
  })
  .returning({ id: episodes.id });

try {
  const result = await withCadenceRun(
    db,
    {
      ownerId: owner.id,
      jobName: "extract_commitments",
      jobId: `extract-episode-${ep!.id}`,
      meta: { episodeId: ep!.id, smoke: true },
    },
    (runId) => extractCommitmentsFromEpisode(db, { ownerId: owner.id, episodeId: ep!.id, runId }),
  );
  console.log("smoke extraction result:", result);
} catch (err) {
  console.error("smoke extraction failed (check /runs for the red row):", (err as Error).message);
} finally {
  await pool.end();
}
