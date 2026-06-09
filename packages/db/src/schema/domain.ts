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
