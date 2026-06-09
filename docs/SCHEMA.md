# Mission Control — Database Schema (v1)

**Deliverable §9.2** · refines the domain model in [PLANNING-BRIEF.md §4](PLANNING-BRIEF.md) per [ARCHITECTURE.md](ARCHITECTURE.md) (Drizzle, Postgres + pgvector, `owner_id` everywhere, `agent_key` attribution per §1.1).

This document *is* the schema: the Drizzle definitions below move verbatim into `packages/db/src/schema/` during Phase 0/1, split by domain as marked. Until then, this file is the source of truth.

---

## 0. One new open choice: embedding provider

The brief locks the LLM layer but is silent on embeddings (Anthropic doesn't ship an embeddings endpoint). **Recommendation: Voyage AI, model `voyage-3.5`, 1024 dimensions**, called through the same `packages/llm` layer (an `embed()` sibling to `complete()`, with the same per-call cost tracking and provider-adapter seam). Rationale: Voyage is Anthropic's recommended embeddings partner, retrieval quality is at or above OpenAI's `text-embedding-3` family at lower cost, and 1024 dims keeps the HNSW index small at single-tenant scale. The dimension is a named constant (`EMBEDDING_DIMS = 1024`) and every memory row records `embedding_model`, so a provider/model swap is a re-embed batch job, not a schema redesign.

## 1. Conventions

- **IDs:** `uuid` primary keys, `gen_random_uuid()` defaults. Natural keys get unique indexes, never PKs.
- **`owner_id`** on every domain table, FK → `users.id`. Every unique index and hot-path index leads with it.
- **`agent_key`** (`text`, default `'chief_of_staff'`) on `briefs`, `context_packets`, `cadence_runs`, `model_calls`, `prompt_versions` — attribution, not ownership (ARCHITECTURE §1.1).
- **Timestamps:** `timestamptz`. `created_at` defaults to `now()`. Append-only tables have no `updated_at`.
- **Status/kind fields:** `text` + `CHECK` constraints for closed domains (commitment status); plain app-validated `text` for open domains (artifact `kind`, task names). No Postgres enums anywhere — enum migrations are the kind of friction this project doesn't need.
- **Money:** `numeric(10,6)` USD for per-call cost.
- **Soft delete:** only where the brief's lifecycle demands it (`memories.status`); everything else is hard data or append-only.

## 2. Drizzle schema

### 2.1 `schema/auth.ts` — user, connections, push, preferences

```ts
import {
  pgTable, uuid, text, timestamp, jsonb, integer, boolean,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per connected Google account. v1 starts with one, but multiple Gmail
// accounts are an expected growth path (R2 decision) — nothing assumes a single row.
export const googleAccounts = pgTable("google_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  email: text("email").notNull(),
  // active | reauth_required — Testing-status OAuth app expires refresh tokens ~weekly
  // (RISK-REGISTER R2); the re-consent flow flips this back to active.
  status: text("status").notNull().default("active"),
  // libsodium sealed box over the OAuth token JSON; key in platform env (ARCHITECTURE §8.3)
  encryptedTokens: text("encrypted_tokens").notNull(),
  scopes: text("scopes").array().notNull(),
  // sync cursors (ARCHITECTURE §2.3)
  gmailHistoryId: text("gmail_history_id"),
  gmailLastSyncAt: timestamp("gmail_last_sync_at", { withTimezone: true }),
  gcalSyncToken: text("gcal_sync_token"),
  gcalLastSyncAt: timestamp("gcal_last_sync_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("google_accounts_owner_email_ux").on(t.ownerId, t.email),
]);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  failureCount: integer("failure_count").notNull().default(0),
  disabledAt: timestamp("disabled_at", { withTimezone: true }), // set after repeated 404/410
}, (t) => [
  uniqueIndex("push_subscriptions_endpoint_ux").on(t.ownerId, t.endpoint),
]);

// Key-value preferences: working hours, flagging rules, brief verbosity, pinned goals refs…
export const userPreferences = pgTable("user_preferences", {
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("user_preferences_pk").on(t.ownerId, t.key),
]);
```

### 2.2 `schema/domain.ts` — people, episodes, commitments, memories, calendar

```ts
import {
  pgTable, uuid, text, timestamp, jsonb, real, date, boolean,
  uniqueIndex, index, check, vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";

export const EMBEDDING_DIMS = 1024; // voyage-3.5 (SCHEMA.md §0)

// Relationship-lite, not a CRM (brief §4).
export const people = pgTable("people", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  displayName: text("display_name").notNull(),
  emails: text("emails").array().notNull().default(sql`'{}'`),
  org: text("org"),
  role: text("role"),
  relationshipType: text("relationship_type"), // client | colleague | vendor | personal | …  (open)
  notes: text("notes"),
  lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("people_owner_ix").on(t.ownerId),
  // GIN over emails[] for sender→person resolution during ingest
  index("people_emails_gin").using("gin", t.emails),
]);

// Append-only event log (brief §4 Episode). No updated_at, no UPDATE path.
export const episodes = pgTable("episodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  type: text("type").notNull(),       // email_received | event_synced | capture | chat_message | … (open)
  source: text("source").notNull(),   // gmail | gcal | manual | chat | system
  summary: text("summary"),
  rawRef: text("raw_ref"),            // e.g. Gmail message id, GCal event id
  payload: jsonb("payload"),          // source-shaped detail (headers, snippet, attendee list…)
  // knowable at insert (sender/attendee resolution happens during ingest).
  // No related_commitment_ids: commitments didn't exist yet when the episode froze —
  // derive the reverse via commitments.source_episode_id / proposals.evidence_episode_id.
  relatedPersonIds: uuid("related_person_ids").array().notNull().default(sql`'{}'`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Ingest idempotency: replaying a sync converges (ARCHITECTURE §5.2)
  uniqueIndex("episodes_owner_source_ref_ux").on(t.ownerId, t.source, t.rawRef)
    .where(sql`raw_ref is not null`),
  index("episodes_owner_occurred_ix").on(t.ownerId, t.occurredAt.desc()),
]);

// The spine (brief §4 Commitment).
export const commitments = pgTable("commitments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  direction: text("direction").notNull(),               // owed_by_me | owed_to_me
  counterpartyPersonId: uuid("counterparty_person_id").references(() => people.id),
  description: text("description").notNull(),
  sourceType: text("source_type").notNull(),            // email | calendar | manual | chat
  sourceEpisodeId: uuid("source_episode_id").references(() => episodes.id),
  sourceRef: text("source_ref"),                        // denormalized from episode for direct trace
  sourceExcerpt: text("source_excerpt"),
  dueDate: date("due_date"),
  dueDateBasis: text("due_date_basis"),                 // explicit | inferred (null when no due date)
  status: text("status").notNull().default("candidate"),// candidate | open | done | dropped
  // snooze is a predicate, not a status: status stays open/candidate, every surface
  // filters on (snoozed_until is null or snoozed_until <= now()); clearing un-snoozes.
  // No wake-up job needed and invariant 5 (dispositions only) stays exact.
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  confidence: real("confidence"),                       // 0–1 from extraction; null for manual
  projectTag: text("project_tag"),
  sensitivity: text("sensitivity").notNull().default("normal"), // normal | sensitive
  // idempotency key for extraction writes: hash(source_ref, normalized description).
  // prompt_version is deliberately NOT part of the key — a version bump must not
  // duplicate already-dispositioned candidates. Second layer: the extraction job
  // skips episodes that already have commitments unless explicitly forced (MC-104).
  extractionHash: text("extraction_hash"),
  promptVersion: text("prompt_version"),                // which extraction prompt produced the candidate
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  lastSurfacedAt: timestamp("last_surfaced_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [
  check("commitments_direction_ck", sql`direction in ('owed_by_me','owed_to_me')`),
  check("commitments_status_ck", sql`status in ('candidate','open','done','dropped')`),
  check("commitments_confidence_ck", sql`confidence is null or (confidence >= 0 and confidence <= 1)`),
  uniqueIndex("commitments_extraction_hash_ux").on(t.ownerId, t.extractionHash)
    .where(sql`extraction_hash is not null`),
  // the two hot queries: confirmation queue, and open-ledger ranking
  index("commitments_owner_status_ix").on(t.ownerId, t.status, t.dueDate),
  index("commitments_counterparty_ix").on(t.counterpartyPersonId),
]);

// Semantic memory (brief §4 Memory). Lifecycle via status; embedding via pgvector.
export const memories = pgTable("memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIMS }),
  embeddingModel: text("embedding_model"),              // e.g. "voyage-3.5" — enables re-embed migration
  sourceEpisodeId: uuid("source_episode_id").references(() => episodes.id),
  source: text("source").notNull(),                     // extraction | manual_pin | chat | system
  confidence: real("confidence"),
  sensitivity: text("sensitivity").notNull().default("normal"),
  status: text("status").notNull().default("active"),   // active | warm | archived | deleted
  pinned: boolean("pinned").notNull().default(false),    // goals live as pinned memories (brief §4)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  reviewAt: timestamp("review_at", { withTimezone: true }), // feeds the Phase-4 review queue
}, (t) => [
  check("memories_status_ck", sql`status in ('active','warm','archived','deleted')`),
  index("memories_owner_status_ix").on(t.ownerId, t.status),
  // HNSW cosine index; tiny corpus in v1 but free to create now
  index("memories_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

// Structured calendar events — meeting-prep needs typed start times and attendees,
// which the generic episodes table can't serve (ARCHITECTURE refinement; Phase 3).
export const calendarEvents = pgTable("calendar_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  gcalEventId: text("gcal_event_id").notNull(),
  title: text("title"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  attendees: jsonb("attendees"),                        // [{email, displayName, personId?}]
  flagged: boolean("flagged").notNull().default(false), // prep-brief flag (rules + manual toggle)
  prepBriefId: uuid("prep_brief_id"),                   // set when the T−45 prep brief generates
  status: text("status").notNull().default("confirmed"),// confirmed | cancelled
  raw: jsonb("raw"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("calendar_events_owner_gcal_ux").on(t.ownerId, t.gcalEventId),
  index("calendar_events_owner_starts_ix").on(t.ownerId, t.startsAt),
]);

// Reconciliation output (ARCHITECTURE §6, CLAUDE.md invariant 5): a pending,
// evidence-backed suggestion that an open commitment changed state. The
// confirmation queue shows pending rows in a distinct section; only a user
// disposition resolves one, and only an accepted proposal touches the commitment.
export const reconciliationProposals = pgTable("reconciliation_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  commitmentId: uuid("commitment_id").notNull().references(() => commitments.id),
  kind: text("kind").notNull(),                 // done | slipped | contradicted
  evidenceEpisodeId: uuid("evidence_episode_id").references(() => episodes.id),
  rationale: text("rationale"),                 // excerpt / why — shown in the queue
  confidence: real("confidence"),
  proposedChanges: jsonb("proposed_changes"),   // e.g. { dueDate: "2026-06-12" } for slipped
  status: text("status").notNull().default("pending"), // pending | accepted | rejected
  cadenceRunId: uuid("cadence_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [
  check("recon_proposals_kind_ck", sql`kind in ('done','slipped','contradicted')`),
  check("recon_proposals_status_ck", sql`status in ('pending','accepted','rejected')`),
  // re-running nightly reconciliation converges: same evidence → same proposal
  uniqueIndex("recon_proposals_dedupe_ux").on(t.ownerId, t.commitmentId, t.kind, t.evidenceEpisodeId),
  index("recon_proposals_owner_status_ix").on(t.ownerId, t.status, t.createdAt.desc()),
]);
```

### 2.3 `schema/artifacts.ts` — context packets, briefs

```ts
import {
  pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

// Persisted input for every generation job — full traceability (ARCHITECTURE §6).
export const contextPackets = pgTable("context_packets", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  agentKey: text("agent_key").notNull().default("chief_of_staff"),
  task: text("task").notNull(),         // e.g. "cos.morning_brief"
  content: jsonb("content").notNull(),  // the assembled packet, exactly as sent
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Immutable generated artifact (brief §4 Brief). Content columns never change
// post-insert; lifecycle columns transition once — opened_at (reader path),
// pushed_at / emailed_at (delivery path).
export const briefs = pgTable("briefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  agentKey: text("agent_key").notNull().default("chief_of_staff"),
  kind: text("kind").notNull(),         // morning | eod | weekly | meeting_prep | … (open, app-validated)
  // generation idempotency: "morning:2026-06-09", "meeting_prep:<gcal_event_id>"
  dedupeKey: text("dedupe_key").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  contentJson: jsonb("content_json").notNull(),  // structured output (Zod-validated)
  contentMd: text("content_md").notNull(),       // rendered, used by reader + email mirror
  contextPacketId: uuid("context_packet_id").notNull().references(() => contextPackets.id),
  cadenceRunId: uuid("cadence_run_id"),          // FK added in activity.ts migration ordering
  openedAt: timestamp("opened_at", { withTimezone: true }),   // graduation-gate metric (brief §8.1)
  pushedAt: timestamp("pushed_at", { withTimezone: true }),
  emailedAt: timestamp("emailed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("briefs_dedupe_ux").on(t.ownerId, t.agentKey, t.dedupeKey),
  index("briefs_owner_kind_ix").on(t.ownerId, t.kind, t.generatedAt.desc()),
]);
```

### 2.4 `schema/activity.ts` — the append-only activity log

```ts
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
```

### 2.5 `schema/evals.ts` — labels and prompt versions

```ts
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
```

## 3. Migration strategy

1. **drizzle-kit SQL migrations, committed to the repo.** `npx drizzle-kit generate` produces numbered SQL files in `packages/db/migrations/`; they are reviewed in PRs like any code. `drizzle-kit push` is forbidden outside throwaway local experiments — prod and CI only ever run `migrate`.
2. **Migration 0000** is hand-edited after generation to prepend `CREATE EXTENSION IF NOT EXISTS vector;` (and `pgcrypto` if the Railway image needs it for `gen_random_uuid()`).
3. **Apply on release.** Railway's release/pre-deploy command for both services runs `npm run db:migrate` (idempotent, journal-tracked). Local dev: same command against the docker-compose Postgres.
4. **Additive-first discipline.** New columns ship nullable-or-defaulted; renames are add → backfill → drop across separate releases. With one user this is overkill — it's practiced anyway because retrofitting the habit is the expensive part (same logic as `owner_id`).
5. **Destructive changes require a backup checkpoint.** Railway Postgres scheduled backups on; any migration containing `DROP` or `ALTER ... TYPE` is run only after confirming a fresh backup exists. This lands in CLAUDE.md's definition of done.
6. **Append-only is enforced in code, not triggers, for v1.** The activity-log writer exposes only `append*` functions (ARCHITECTURE §8.2). If that ever feels insufficient, the one-migration hardening (MC-901) is: `REVOKE DELETE` on all four activity tables; `REVOKE UPDATE` on `model_calls` and `user_actions`; column-level `GRANT UPDATE (status, finished_at, error)` on `cadence_runs` and `GRANT UPDATE (status, finished_at, detail)` on `run_steps` — the lifecycle-column exception, enforced exactly.
7. **Re-embedding path:** `memories.embedding_model` + nullable `embedding` means an embedding-provider change is: add new column? No — same column, batch job re-embeds rows where `embedding_model != current`, updates both fields. Dimension changes (rare) are the one case needing a real migration; that's why dims are a named constant referenced in exactly one place.

## 4. Deliberate refinements vs. brief §4 (so they're visible in review)

| Brief said | Schema does | Why |
|---|---|---|
| `Person.names/emails[]` | single `display_name` + `emails[]` | one canonical name; aliases weren't earning a column |
| `Commitment.source_ref` only | + `source_episode_id` FK | trace lands on the episode row, not just an opaque ref |
| `Brief.kind` enum of four | open `text` + `dedupe_key` | ARCHITECTURE §1.1; dedupe key gives generation idempotency |
| `Memory` (no pinned) | + `pinned` boolean | brief §4 says goals are "pinned semantic memories" — needs the flag |
| — | `calendar_events` table | meeting prep needs typed `starts_at`/attendees; episodes are untyped |
| — | `extraction_labels`, `prompt_versions` | brief §5's eval loop needs a queryable contract |
| "reconciliation → proposals" (invariant, no shape) | `reconciliation_proposals` table | the queue must show a proposal *before* any disposition exists; evidence + history need rows, not `user_actions` payloads |
| `CadenceRun/ActivityLog` (one concept) | 4 tables: runs, steps, model_calls, user_actions | distinct write paths and query shapes; all append-only |
| `status` includes `snoozed` | snooze = `snoozed_until` timestamp only | a status needs a waker, which violates invariant 5 (dispositions only); a timestamp wakes by WHERE clause — no job, no exception |
| `Episode.related_commitment_ids[]` | dropped | unpopulatable on an append-only table (commitments exist only after the episode is frozen); the FKs on commitments/proposals already point the other way |
