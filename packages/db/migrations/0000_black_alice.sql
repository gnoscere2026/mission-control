-- hand-prepended per SCHEMA.md §3.2: pgvector must exist before the memories.embedding column
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "google_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"encrypted_tokens" text NOT NULL,
	"scopes" text[] NOT NULL,
	"gmail_history_id" text,
	"gmail_last_sync_at" timestamp with time zone,
	"gcal_sync_token" text,
	"gcal_last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"owner_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"gcal_event_id" text NOT NULL,
	"title" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"attendees" jsonb,
	"flagged" boolean DEFAULT false NOT NULL,
	"prep_brief_id" uuid,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"raw" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"counterparty_person_id" uuid,
	"description" text NOT NULL,
	"source_type" text NOT NULL,
	"source_episode_id" uuid,
	"source_ref" text,
	"source_excerpt" text,
	"due_date" date,
	"due_date_basis" text,
	"status" text DEFAULT 'candidate' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"confidence" real,
	"project_tag" text,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"extraction_hash" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_surfaced_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "commitments_direction_ck" CHECK (direction in ('owed_by_me','owed_to_me')),
	CONSTRAINT "commitments_status_ck" CHECK (status in ('candidate','open','done','dropped')),
	CONSTRAINT "commitments_confidence_ck" CHECK (confidence is null or (confidence >= 0 and confidence <= 1))
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"summary" text,
	"raw_ref" text,
	"payload" jsonb,
	"related_person_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"source_episode_id" uuid,
	"source" text NOT NULL,
	"confidence" real,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"review_at" timestamp with time zone,
	CONSTRAINT "memories_status_ck" CHECK (status in ('active','warm','archived','deleted'))
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"emails" text[] DEFAULT '{}' NOT NULL,
	"org" text,
	"role" text,
	"relationship_type" text,
	"notes" text,
	"last_contact_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"commitment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"evidence_episode_id" uuid,
	"rationale" text,
	"confidence" real,
	"proposed_changes" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"cadence_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "recon_proposals_kind_ck" CHECK (kind in ('done','slipped','contradicted')),
	CONSTRAINT "recon_proposals_status_ck" CHECK (status in ('pending','accepted','rejected'))
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_key" text DEFAULT 'chief_of_staff' NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_json" jsonb NOT NULL,
	"content_md" text NOT NULL,
	"context_packet_id" uuid NOT NULL,
	"cadence_run_id" uuid,
	"opened_at" timestamp with time zone,
	"pushed_at" timestamp with time zone,
	"emailed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "context_packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_key" text DEFAULT 'chief_of_staff' NOT NULL,
	"task" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cadence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_key" text DEFAULT 'chief_of_staff' NOT NULL,
	"job_name" text NOT NULL,
	"job_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"meta" jsonb,
	CONSTRAINT "cadence_runs_status_ck" CHECK (status in ('running','succeeded','failed'))
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_key" text DEFAULT 'chief_of_staff' NOT NULL,
	"run_id" uuid,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tier" text NOT NULL,
	"prompt_version" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"latency_ms" integer NOT NULL,
	"data_categories" text[] DEFAULT '{}' NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "user_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"commitment_id" uuid NOT NULL,
	"source_episode_id" uuid,
	"label" text NOT NULL,
	"edited_fields" jsonb,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_labels_label_ck" CHECK (label in ('confirmed','edited','rejected'))
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_key" text DEFAULT 'chief_of_staff' NOT NULL,
	"task" text NOT NULL,
	"version" text NOT NULL,
	"content_hash" text NOT NULL,
	"eval_precision" real,
	"eval_recall" real,
	"eval_fixture_count" integer,
	"eval_run_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_counterparty_person_id_people_id_fk" FOREIGN KEY ("counterparty_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_source_episode_id_episodes_id_fk" FOREIGN KEY ("source_episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_episode_id_episodes_id_fk" FOREIGN KEY ("source_episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_proposals" ADD CONSTRAINT "reconciliation_proposals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_proposals" ADD CONSTRAINT "reconciliation_proposals_commitment_id_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_proposals" ADD CONSTRAINT "reconciliation_proposals_evidence_episode_id_episodes_id_fk" FOREIGN KEY ("evidence_episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_context_packet_id_context_packets_id_fk" FOREIGN KEY ("context_packet_id") REFERENCES "public"."context_packets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_packets" ADD CONSTRAINT "context_packets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cadence_runs" ADD CONSTRAINT "cadence_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_run_id_cadence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."cadence_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_cadence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."cadence_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_actions" ADD CONSTRAINT "user_actions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_labels" ADD CONSTRAINT "extraction_labels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_labels" ADD CONSTRAINT "extraction_labels_commitment_id_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_labels" ADD CONSTRAINT "extraction_labels_source_episode_id_episodes_id_fk" FOREIGN KEY ("source_episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_accounts_owner_email_ux" ON "google_accounts" USING btree ("owner_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_ux" ON "push_subscriptions" USING btree ("owner_id","endpoint");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_pk" ON "user_preferences" USING btree ("owner_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_owner_gcal_ux" ON "calendar_events" USING btree ("owner_id","gcal_event_id");--> statement-breakpoint
CREATE INDEX "calendar_events_owner_starts_ix" ON "calendar_events" USING btree ("owner_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "commitments_extraction_hash_ux" ON "commitments" USING btree ("owner_id","extraction_hash") WHERE extraction_hash is not null;--> statement-breakpoint
CREATE INDEX "commitments_owner_status_ix" ON "commitments" USING btree ("owner_id","status","due_date");--> statement-breakpoint
CREATE INDEX "commitments_counterparty_ix" ON "commitments" USING btree ("counterparty_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_owner_source_ref_ux" ON "episodes" USING btree ("owner_id","source","raw_ref") WHERE raw_ref is not null;--> statement-breakpoint
CREATE INDEX "episodes_owner_occurred_ix" ON "episodes" USING btree ("owner_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memories_owner_status_ix" ON "memories" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "memories_embedding_hnsw" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "people_owner_ix" ON "people" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "people_emails_gin" ON "people" USING gin ("emails");--> statement-breakpoint
CREATE UNIQUE INDEX "recon_proposals_dedupe_ux" ON "reconciliation_proposals" USING btree ("owner_id","commitment_id","kind","evidence_episode_id");--> statement-breakpoint
CREATE INDEX "recon_proposals_owner_status_ix" ON "reconciliation_proposals" USING btree ("owner_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "briefs_dedupe_ux" ON "briefs" USING btree ("owner_id","agent_key","dedupe_key");--> statement-breakpoint
CREATE INDEX "briefs_owner_kind_ix" ON "briefs" USING btree ("owner_id","kind","generated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cadence_runs_owner_started_ix" ON "cadence_runs" USING btree ("owner_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cadence_runs_job_ix" ON "cadence_runs" USING btree ("owner_id","job_name","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "model_calls_owner_created_ix" ON "model_calls" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "model_calls_run_ix" ON "model_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_steps_run_ix" ON "run_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "user_actions_owner_created_ix" ON "user_actions" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_actions_entity_ix" ON "user_actions" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "extraction_labels_prompt_ix" ON "extraction_labels" USING btree ("prompt_version");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_ux" ON "prompt_versions" USING btree ("agent_key","task","version");