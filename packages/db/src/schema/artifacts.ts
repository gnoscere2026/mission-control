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
