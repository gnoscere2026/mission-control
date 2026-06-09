import {
  pgTable, uuid, text, timestamp, jsonb, integer, numeric,
  index, check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";

// One row per job execution (ARCHITECTURE §5.2). Insert-only except the once-only
// lifecycle close (status, finished_at, error) written by the run-bracketing helper.
export const cadenceRuns = pgTable("cadence_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  agentKey: text("agent_key").notNull().default("chief_of_staff"),
  jobName: text("job_name").notNull(),  // ingest_gmail | extract_commitments | morning_brief | …
  jobId: text("job_id").notNull(),      // the deterministic BullMQ jobId
  status: text("status").notNull().default("running"), // running | succeeded | failed
  attempt: integer("attempt").notNull().default(1),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text("error"),
  meta: jsonb("meta"),
}, (t) => [
  check("cadence_runs_status_ck", sql`status in ('running','succeeded','failed')`),
  index("cadence_runs_owner_started_ix").on(t.ownerId, t.startedAt.desc()),
  index("cadence_runs_job_ix").on(t.ownerId, t.jobName, t.startedAt.desc()),
]);

export const runSteps = pgTable("run_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => cadenceRuns.id),
  seq: integer("seq").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),     // ok | failed | skipped
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  detail: jsonb("detail"),
}, (t) => [
  index("run_steps_run_ix").on(t.runId, t.seq),
]);

// Every model call, no exceptions (invariant 3). Written only by packages/llm.
export const modelCalls = pgTable("model_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  agentKey: text("agent_key").notNull().default("chief_of_staff"),
  runId: uuid("run_id").references(() => cadenceRuns.id), // null for web-initiated (chat) calls
  task: text("task").notNull(),         // "cos.extract_commitments", "embed.memory", …
  provider: text("provider").notNull(), // anthropic | voyage | …
  model: text("model").notNull(),
  tier: text("tier").notNull(),         // cheap | mid | top | embed
  promptVersion: text("prompt_version"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull(),
  latencyMs: integer("latency_ms").notNull(),
  dataCategories: text("data_categories").array().notNull().default(sql`'{}'`), // email | calendar | memory | commitment | capture
  status: text("status").notNull(),     // ok | schema_retry_ok | failed
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("model_calls_owner_created_ix").on(t.ownerId, t.createdAt.desc()),
  index("model_calls_run_ix").on(t.runId),
]);

// Every user disposition: confirm/edit/reject/snooze, brief opened, capture submitted, settings changed.
export const userActions = pgTable("user_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  action: text("action").notNull(),       // commitment_confirmed | commitment_rejected | brief_opened | …
  entityType: text("entity_type"),        // commitment | brief | memory | …
  entityId: uuid("entity_id"),
  payload: jsonb("payload"),              // e.g. the edited fields on commitment_edited
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("user_actions_owner_created_ix").on(t.ownerId, t.createdAt.desc()),
  index("user_actions_entity_ix").on(t.entityType, t.entityId),
]);
