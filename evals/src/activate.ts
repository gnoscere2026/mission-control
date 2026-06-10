import { eq, and } from "drizzle-orm";
import { ACTIVE_EXTRACTION } from "@mission-control/core";
import { createDb, promptVersions } from "@mission-control/db";
import { loadCommittedResults } from "./runner";

// EVAL-SPEC §5.3: activation writes the prompt_versions row FROM the committed
// results file — the repo is the source of truth for eval history; the runner
// never touches prompt_versions. Run after deploy (or locally) whenever the
// active version reference changes:  npm run eval:activate -w evals

const task = ACTIVE_EXTRACTION.task;
const version = ACTIVE_EXTRACTION.version;
const results = loadCommittedResults(task, version);
if (!results) {
  console.error(
    `no committed results file for ${task}/${version} — run \`npm run eval -- --task ${task}\` and commit evals/results/ first`,
  );
  process.exit(1);
}
if (results.promptContentHash !== ACTIVE_EXTRACTION.contentHash()) {
  console.error(
    `committed results were produced by a different prompt than the active module (content hash mismatch) — re-run the eval`,
  );
  process.exit(1);
}

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";
const { db, pool } = createDb(url);

await db
  .insert(promptVersions)
  .values({
    task,
    version,
    contentHash: results.promptContentHash,
    evalPrecision: results.precision,
    evalRecall: results.recall,
    evalFixtureCount: results.fixtureCount,
    evalRunAt: new Date(results.generatedAt),
    activatedAt: new Date(),
  })
  .onConflictDoUpdate({
    target: [promptVersions.agentKey, promptVersions.task, promptVersions.version],
    set: {
      contentHash: results.promptContentHash,
      evalPrecision: results.precision,
      evalRecall: results.recall,
      evalFixtureCount: results.fixtureCount,
      evalRunAt: new Date(results.generatedAt),
      activatedAt: new Date(),
    },
  });

const [row] = await db
  .select()
  .from(promptVersions)
  .where(and(eq(promptVersions.task, task), eq(promptVersions.version, version)));
console.log(
  `activated ${task} ${version}: precision=${row!.evalPrecision} recall=${row!.evalRecall} fixtures=${row!.evalFixtureCount}`,
);
await pool.end();
