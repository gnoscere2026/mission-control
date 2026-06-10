import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  EXTRACTION_VERSIONS,
  ACTIVE_EXTRACTION,
  type ExtractedCommitmentT,
  type ExtractionInput,
  type ExtractionPromptModule,
} from "@mission-control/core";
import { complete } from "@mission-control/llm";
import { createDb, users, type Db } from "@mission-control/db";
import { fixtureSetHash, loadFixtures, type FixtureT } from "./fixtures";
import { makeCachedJudge } from "./judge";
import { matchFixture } from "./match";

export const RESULTS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "results",
);

const EVAL_OWNER_EMAIL = "eval@local.test";
const OWNER_NAME = "Mark";
const OWNER_EMAIL_FIXTURE = "mark@example.com"; // fixtures address the owner this way

// EVAL-SPEC §4: eval model_calls go to a local/CI throwaway DB, never prod.
export function guardDatabaseUrl(url: string): void {
  const host = new URL(url).hostname;
  if (host === "localhost" || host === "127.0.0.1") return;
  if (process.env.EVAL_ALLOW_REMOTE_DB === "1") return;
  throw new Error(
    `eval runner refuses non-local DATABASE_URL host "${host}" (set EVAL_ALLOW_REMOTE_DB=1 only if you are sure this is not production)`,
  );
}

async function ensureEvalOwner(db: Db): Promise<string> {
  await db
    .insert(users)
    .values({ email: EVAL_OWNER_EMAIL, displayName: OWNER_NAME })
    .onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, EVAL_OWNER_EMAIL));
  return u!.id;
}

export interface EvalMetrics {
  task: string;
  version: string;
  promptContentHash: string;
  fixtureSetHash: string;
  fixtureCount: number;
  expectedTotal: number;
  predictedTotal: number;
  matches: number;
  precision: number;
  recall: number;
  f1: number;
  hardNegative: {
    fixtures: number;
    fixturesWithPredictions: number;
    falsePositivePredictions: number;
    cleanRate: number; // 1.0 = no hard negative produced any prediction
  };
  dueDateAccuracy: number | null; // among matches with an expected due date
  basisSoftMisses: number;
  schemaFailures: number;
  costUsd: number;
  meanLatencyMs: number;
  judgeCacheMisses: number;
  generatedAt: string;
  failures: { fixtureId: string; falsePositives: string[]; falseNegatives: string[] }[];
}

export interface RunEvalOpts {
  task: string;
  version?: string;
  fixturesFilter?: string;
  databaseUrl?: string;
  writeResults?: boolean;
}

function fixtureToInput(f: FixtureT): ExtractionInput {
  return {
    sourceType: f.source_type,
    ownerName: OWNER_NAME,
    ownerEmails: [OWNER_EMAIL_FIXTURE],
    from: f.input.from,
    to: f.input.to,
    subject: f.input.subject,
    occurredAt: f.input.occurred_at,
    body: f.input.body,
  };
}

export async function runEval(opts: RunEvalOpts): Promise<EvalMetrics> {
  if (opts.task !== "cos.extract_commitments") {
    throw new Error(`unknown eval task "${opts.task}"`);
  }
  const version = opts.version ?? ACTIVE_EXTRACTION.version;
  const prompt: ExtractionPromptModule | undefined = EXTRACTION_VERSIONS[version];
  if (!prompt) throw new Error(`no extraction prompt version "${version}" in the registry`);

  const dbUrl =
    opts.databaseUrl ??
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5433/mission_control";
  guardDatabaseUrl(dbUrl);
  const { db, pool } = createDb(dbUrl);

  try {
    const ownerId = await ensureEvalOwner(db);
    const fixtures = loadFixtures(undefined, opts.fixturesFilter);
    const { judge, flush, misses } = makeCachedJudge(db, ownerId);

    let expectedTotal = 0;
    let predictedTotal = 0;
    let matchCount = 0;
    let dueExpectedMatches = 0;
    let dueCorrect = 0;
    let basisSoftMisses = 0;
    let schemaFailures = 0;
    let costUsd = 0;
    let latencyTotal = 0;
    let hardNegFixtures = 0;
    let hardNegWithPreds = 0;
    let hardNegFalsePos = 0;
    const failures: EvalMetrics["failures"] = [];

    for (const fixture of fixtures) {
      const input = fixtureToInput(fixture);
      let predicted: ExtractedCommitmentT[] = [];
      try {
        const result = await complete({
          db,
          ownerId,
          task: prompt.task,
          schema: prompt.schema,
          system: prompt.system,
          prompt: prompt.renderPrompt(input),
          promptVersion: prompt.version,
          dataCategories: ["capture"],
        });
        predicted = result.data.commitments;
        costUsd += Number(result.costUsd);
        latencyTotal += result.latencyMs;
      } catch (err) {
        // a schema failure counts every expected item as missed — visible, not fatal
        schemaFailures++;
        console.error(`  ! ${fixture.id}: ${(err as Error).message.slice(0, 120)}`);
      }

      expectedTotal += fixture.expected.length;
      predictedTotal += predicted.length;

      const match = await matchFixture(fixture.expected, predicted, {
        aliases: fixture.aliases,
        judge,
      });
      matchCount += match.matches.length;
      basisSoftMisses += match.matches.filter((m) => m.basisSoftMiss).length;
      for (const m of match.matches) {
        if (fixture.expected[m.expIdx]!.due !== null) {
          dueExpectedMatches++;
          if (m.dueDateOk) dueCorrect++;
        }
      }

      if (fixture.expected.length === 0) {
        hardNegFixtures++;
        if (predicted.length > 0) {
          hardNegWithPreds++;
          hardNegFalsePos += predicted.length;
        }
      }

      if (match.falsePositives.length > 0 || match.falseNegatives.length > 0) {
        failures.push({
          fixtureId: fixture.id,
          falsePositives: match.falsePositives.map((i) => predicted[i]!.description),
          falseNegatives: match.falseNegatives.map((i) => fixture.expected[i]!.description_gist),
        });
      }
    }

    flush();

    const precision = predictedTotal === 0 ? 1 : matchCount / predictedTotal;
    const recall = expectedTotal === 0 ? 1 : matchCount / expectedTotal;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    const metrics: EvalMetrics = {
      task: opts.task,
      version,
      promptContentHash: prompt.contentHash(),
      fixtureSetHash: fixtureSetHash(fixtures),
      fixtureCount: fixtures.length,
      expectedTotal,
      predictedTotal,
      matches: matchCount,
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      hardNegative: {
        fixtures: hardNegFixtures,
        fixturesWithPredictions: hardNegWithPreds,
        falsePositivePredictions: hardNegFalsePos,
        cleanRate: round(hardNegFixtures === 0 ? 1 : (hardNegFixtures - hardNegWithPreds) / hardNegFixtures),
      },
      dueDateAccuracy: dueExpectedMatches === 0 ? null : round(dueCorrect / dueExpectedMatches),
      basisSoftMisses,
      schemaFailures,
      costUsd: Number(costUsd.toFixed(6)),
      meanLatencyMs: fixtures.length ? Math.round(latencyTotal / fixtures.length) : 0,
      judgeCacheMisses: misses(),
      generatedAt: new Date().toISOString(),
      failures,
    };

    if (opts.writeResults !== false) {
      const dir = path.join(RESULTS_DIR, opts.task);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${version}.json`), JSON.stringify(metrics, null, 2) + "\n");
    }
    return metrics;
  } finally {
    await pool.end();
  }
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function loadCommittedResults(task: string, version: string): EvalMetrics | undefined {
  const file = path.join(RESULTS_DIR, task, `${version}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as EvalMetrics;
}

export function printTable(m: EvalMetrics, against?: EvalMetrics): void {
  const delta = (a: number, b?: number) =>
    b === undefined ? "" : `  (${a - b >= 0 ? "+" : ""}${round(a - b)})`;
  console.log(`\n  eval ${m.task} ${m.version} — ${m.fixtureCount} fixtures`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  precision            ${m.precision}${delta(m.precision, against?.precision)}`);
  console.log(`  recall               ${m.recall}${delta(m.recall, against?.recall)}`);
  console.log(`  f1                   ${m.f1}${delta(m.f1, against?.f1)}`);
  console.log(
    `  hard-neg clean rate  ${m.hardNegative.cleanRate}${delta(m.hardNegative.cleanRate, against?.hardNegative.cleanRate)}  (${m.hardNegative.fixturesWithPredictions}/${m.hardNegative.fixtures} negatives produced output)`,
  );
  console.log(`  due-date accuracy    ${m.dueDateAccuracy ?? "n/a"}`);
  console.log(`  basis soft-misses    ${m.basisSoftMisses}`);
  console.log(`  schema failures      ${m.schemaFailures}`);
  console.log(`  cost                 $${m.costUsd}  ·  mean latency ${m.meanLatencyMs}ms`);
  console.log(`  judge cache misses   ${m.judgeCacheMisses}`);
  if (m.failures.length) {
    console.log(`\n  mismatches:`);
    for (const f of m.failures) {
      if (f.falsePositives.length) console.log(`    ${f.fixtureId} FP: ${f.falsePositives.join(" | ")}`);
      if (f.falseNegatives.length) console.log(`    ${f.fixtureId} FN: ${f.falseNegatives.join(" | ")}`);
    }
  }
  console.log("");
}
