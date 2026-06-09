import {
  pgTable, uuid, text, timestamp, jsonb, real, integer, uniqueIndex, index, check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { commitments, episodes } from "./domain";

// Labeled training/eval signal from the confirmation queue (brief §5).
// Derivable from user_actions in principle; explicit table so the eval harness
// has a stable, queryable contract.
export const extractionLabels = pgTable("extraction_labels", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  commitmentId: uuid("commitment_id").notNull().references(() => commitments.id),
  sourceEpisodeId: uuid("source_episode_id").references(() => episodes.id),
  label: text("label").notNull(),            // confirmed | edited | rejected
  editedFields: jsonb("edited_fields"),      // diff when label = edited
  promptVersion: text("prompt_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("extraction_labels_label_ck", sql`label in ('confirmed','edited','rejected')`),
  index("extraction_labels_prompt_ix").on(t.promptVersion),
]);

// Prompts live in-repo; this table records eval results and activation per version
// (brief §5: changes gated on eval runs). agent_key per ARCHITECTURE §1.1.
export const promptVersions = pgTable("prompt_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentKey: text("agent_key").notNull().default("chief_of_staff"),
  task: text("task").notNull(),              // "cos.extract_commitments"
  version: text("version").notNull(),        // e.g. "v3" — matches the in-repo prompt module
  contentHash: text("content_hash").notNull(),
  evalPrecision: real("eval_precision"),
  evalRecall: real("eval_recall"),
  evalFixtureCount: integer("eval_fixture_count"),
  evalRunAt: timestamp("eval_run_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }), // null = never deployed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("prompt_versions_ux").on(t.agentKey, t.task, t.version),
]);
