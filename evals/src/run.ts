import { ACTIVE_EXTRACTION } from "@mission-control/core";
import { loadCommittedResults, printTable, runEval } from "./runner";

// npm run eval -- --task cos.extract_commitments [--version v1] [--against active]
//                 [--fixtures <substr>] [--assert-committed]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const task = arg("task");
if (!task) {
  console.error("usage: npm run eval -- --task cos.extract_commitments [--version vN] [--against active] [--assert-committed]");
  process.exit(1);
}

const version = arg("version") ?? ACTIVE_EXTRACTION.version;
const assertCommitted = flag("assert-committed");
const committedBefore = loadCommittedResults(task, version);

if (assertCommitted && !committedBefore) {
  console.error(
    `--assert-committed: no committed results file for ${task}/${version} — run the eval locally and commit evals/results/${task}/${version}.json (EVAL-SPEC §5.1)`,
  );
  process.exit(1);
}

const metrics = await runEval({
  task,
  version,
  fixturesFilter: arg("fixtures"),
  // CI mode re-runs for comparison; don't clobber the committed file
  writeResults: !assertCommitted,
});

let against;
if (arg("against") === "active") {
  against = loadCommittedResults(task, ACTIVE_EXTRACTION.version);
  if (!against) console.error(`no committed results for active version ${ACTIVE_EXTRACTION.version}`);
}
printTable(metrics, against);

if (assertCommitted && committedBefore) {
  const problems: string[] = [];
  if (committedBefore.promptContentHash !== metrics.promptContentHash) {
    problems.push(
      `committed results were produced by a different prompt (content hash mismatch) — re-run the eval and commit fresh numbers`,
    );
  }
  const TOLERANCE = 0.02; // judge cache makes reruns near-deterministic (EVAL-SPEC §5.1)
  for (const key of ["precision", "recall"] as const) {
    const drift = Math.abs(committedBefore[key] - metrics[key]);
    if (drift > TOLERANCE) {
      problems.push(`${key} drifted ${drift.toFixed(4)} from the committed value (> ${TOLERANCE})`);
    }
  }
  if (problems.length) {
    console.error("assert-committed FAILED:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  console.log("assert-committed OK — committed results match the live re-run");
}
