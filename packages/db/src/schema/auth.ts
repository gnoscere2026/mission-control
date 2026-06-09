import {
  pgTable, uuid, text, timestamp, jsonb, integer,
  uniqueIndex,
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
