# Mission Control — Epics & Tickets (v1)

**Deliverable §9.4** · sequencing in [BUILD-PLAN.md](BUILD-PLAN.md) · every ticket sized for **one Claude Code session** (plan-mode plan → approval → implementation → review).

Ticket conventions:
- **AC** = acceptance criteria (human-verifiable). **Tests** = what CI must prove.
- Every ticket implicitly includes the CLAUDE.md definition of done: migrations applied, activity-log coverage for new write paths, failures visible (no silent catch), eval run if extraction was touched.
- Dependencies are strictly the previous ticket unless noted.

---

## Epic E0 — Walking Skeleton (Phase 0)

### MC-001 · Monorepo scaffold
npm-workspaces root; `apps/web`, `apps/worker`, `packages/db`, `packages/core`, `packages/llm`, `evals/` stubs; shared `tsconfig` base; ESLint + Prettier; root scripts (`dev`, `build`, `typecheck`, `lint`, `test` via Vitest).
**AC:** fresh clone → `npm i && npm run typecheck && npm run test` passes; each workspace importable by name.
**Tests:** one placeholder test per workspace proving the test runner resolves workspace imports.

### MC-002 · `packages/db` + local stack
Drizzle schema files transcribed from [SCHEMA.md §2](SCHEMA.md) verbatim; migration 0000 generated and hand-prepended with `CREATE EXTENSION IF NOT EXISTS vector`; client factory (`createDb(connectionString)`); `docker-compose.yml` with Postgres (pgvector image) + Redis; `db:generate` / `db:migrate` / `db:studio` scripts; seed script inserting the single `users` row from env.
**AC:** `docker compose up -d && npm run db:migrate && npm run db:seed` yields a queryable schema matching SCHEMA.md; re-running migrate is a no-op.
**Tests:** migration applies on a clean Postgres in CI (throwaway container); seed is idempotent.

### MC-003 · Web + worker skeletons, auth-lite
`apps/web`: Next.js App Router, iron-session cookie auth with single shared-secret login page, all routes gated, `/api/health`; every server-side query helper takes `ownerId` (resolved from session) — no ownerless query path exists. `apps/worker`: BullMQ connection, queue registry per ARCHITECTURE §5.1 (queues declared, handlers stubbed), graceful shutdown, and the run-bracketing helper: `withCadenceRun(jobName, jobId, fn)` writing `cadence_runs` open/close/fail.
**AC:** wrong secret → no session; right secret → app; worker starts, registers repeatables, exits cleanly on SIGTERM; a stub job leaves a succeeded `cadence_runs` row.
**Tests:** auth round-trip; `withCadenceRun` writes running→succeeded and running→failed rows (including on thrown errors).

### MC-004 · Railway deploy + CI
Railway project: web service, worker service, Redis, Postgres(pgvector) from monorepo subpaths; env wiring (`DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `TOKEN_SEAL_KEY`); pre-deploy `db:migrate`; GitHub Actions: typecheck, lint, test, clean-postgres migration check, drift check (`drizzle-kit generate` produces no diff).
**AC:** push to `main` deploys both services; `/api/health` green from the public URL; worker logs show repeatables registered; migrations ran in release phase.
**Tests:** CI is the test — all five checks required on `main`.

### MC-005 · Hello brief job + email mirror + reader
Repeatable job `morning_brief` (7:00 AM `America/Denver`), jobId `morning-brief:<YYYY-MM-DD>`; writes a `context_packets` row (trivial content) and a `briefs` row (`kind='morning'`, dedupe key `morning:<date>`, placeholder content); `notify` job sends the plain email mirror (nodemailer + SMTP creds in env); minimal `/briefs/[id]` reader page; brief list page.
**AC:** trigger manually + observe at 7 AM: brief row, email received, readable in app; re-enqueueing the same jobId/dedupe key creates nothing.
**Tests:** dedupe-key uniqueness on double-run; email renderer snapshot; failed SMTP send → failed `cadence_runs` row, not a swallowed error.

### MC-006 · Web push + PWA install
`manifest.webmanifest`, service worker (push event → notification → click-through to brief), `/api/push/subscribe` storing `push_subscriptions`, VAPID keys in env, `web-push` sender in worker wired into `notify`; iOS detection + Add-to-Home-Screen instruction screen; settings page push-enable flow.
**AC:** on Mark's iPhone (installed PWA) and desktop Chrome: hello brief push arrives, tap opens the brief. 404/410 responses increment `failure_count` and disable after 5.
**Tests:** subscribe endpoint validation; sender marks `pushed_at`; pruning logic on gone-subscription responses.

---

## Epic E1 — Ledger (Phase 1)

### MC-101 · Google OAuth + sealed-box token storage
OAuth connect flow requesting exactly `gmail.readonly` + `calendar.readonly`; callback stores tokens via `core/crypto` (libsodium sealed box, key from `TOKEN_SEAL_KEY`); refresh handling; settings page connect/disconnect; `user_actions` records connect events.
**AC:** connect from settings → `google_accounts` row with encrypted tokens (verify ciphertext in SQL console); an expired access token transparently refreshes on next use.
**Tests:** seal/unseal round-trip; refresh path with mocked Google token endpoint; scope list asserted — a PR that widens scopes must fail a test.

### MC-102 · Gmail ingest
`ingest_gmail` job (every 15 min, working-hours window from `user_preferences`): `history.list` from cursor → `messages.get` (metadata + body excerpt) → `episodes` upsert on `(owner, source, raw_ref)`; cursor advance; 404-cursor fallback (`messages.list` `after:` last sync, reset cursor); sender resolution against `people.emails` (auto-create person, set `last_contact_at`); enqueue one `extraction` job per new episode; run steps recorded.
**AC:** send self an email → episode row within 15 min with person linked; replaying the same history window creates zero rows; quota use visible in run meta.
**Tests:** sync against recorded Gmail API fixtures (happy path, empty delta, 404 fallback); idempotent replay; person create-vs-match.

### MC-103 · GCal ingest
`ingest_gcal` in the same cadence: incremental sync via `syncToken` into `calendar_events` (upsert on `gcal_event_id`) + an episode per new/changed event; cancellation handling (`status='cancelled'`); attendee emails resolved to people.
**AC:** create/move/cancel an event in Google Calendar → row reflects each within 15 min.
**Tests:** fixture-driven sync incl. token-expiry full resync; upsert convergence; cancellation.

### MC-104 · LLM layer + commitment extraction
`packages/llm`: `complete()` per ARCHITECTURE §8.1 (tier config, Anthropic adapter, Zod→JSON-Schema forced tool-use with `strict: true`, one schema-feedback retry, `model_calls` record with cost from in-repo price table, data categories, latency); `cos.extract_commitments` prompt v1 + Zod schema in `packages/core/extraction/` (versioned module); `extraction` job handler: episode → candidates with `confidence`, `source_excerpt`, `extraction_hash` (= hash(source_ref, normalized description) — version-free, SCHEMA §2.2), `prompt_version` (attribution only); episode guard: skip episodes that already have commitments unless explicitly forced — episodes are immutable, so re-extraction is never new information; provider-SDK import lint rule (only `packages/llm` may import `@anthropic-ai/sdk` etc.).
**AC:** the MC-102 test email yields a `candidate` commitment with sane fields; `model_calls` row shows haiku-tier, tokens, cost; malformed-output path visibly fails after one retry.
**Tests:** schema-validation retry path (mocked malformed→valid); extraction-hash idempotency (re-run job → no dup); episode guard (re-run after a prompt-version bump → no duplicate candidate, even when v2 words the same obligation differently); cost arithmetic; lint rule fails on a planted bad import. **Eval run required** (MC-106 lands the harness; until then record prompt v1 hash in `prompt_versions`).

### MC-105 · Confirmation queue UI
`/queue`: candidates newest-first with source excerpt + person + confidence; one-tap **confirm** (→`open`, `confirmed_at`), **reject** (→`dropped`), **edit** (field sheet, then confirm); **snooze** (sets `snoozed_until`, status unchanged — surfaces filter on it, waking is automatic by query); every disposition writes `user_actions` + `extraction_labels` (label, edited_fields diff, prompt_version); ledger page `/commitments` (open / owed-to-me / snoozed views — snoozed is a predicate over `snoozed_until`, not a status; manual add).
**AC:** all four dispositions work in two taps or less on a phone; label rows verifiably written; manually added commitment skips candidate state.
**Tests:** disposition state transitions incl. timestamps; label payloads; ownerless access impossible (route guard test).

### MC-106 · Eval harness v1
Per [EVAL-SPEC.md](EVAL-SPEC.md): `evals/fixtures/` JSON fixtures (≥25, anonymized via the spec's workflow), runner (`npm run eval -- --task cos.extract_commitments`) computing precision/recall/F1 with the spec's matching rules, results written to `prompt_versions` + printed table; comparison mode against the activated version; CI job (manual dispatch + required when `packages/core/extraction/**` changes).
**AC:** baseline numbers for prompt v1 recorded; changing a prompt without an eval run fails CI on extraction paths.
**Tests:** runner on a tiny known fixture set asserts exact P/R; matcher unit tests (the spec's match rules).

### MC-107 · Run-health page
`/runs`: last run per job with status/duration/attempt, failure rows red with error detail, step drill-down, manual retry button (re-enqueues with same jobId semantics); nav badge when any latest-run failed.
**AC:** a forced ingest failure is visible within one refresh and retryable in-app; "the Morning Brief did not go out" is answerable here in <10 seconds.
**Tests:** query shapes (latest-per-job); retry enqueue; badge logic.

---

## Epic E2 — Morning Brief (Phase 2)

### MC-201 · Embeddings + memories
`embed()` in `packages/llm` (Voyage adapter, `embed` tier, cost-tracked `model_calls`); `memories` write paths: manual pin (UI on capture/chat), capture-to-memory; retrieval helper: cosine top-k via HNSW blended with recency, filtered by `status='active'`, updates `last_used_at`.
**AC:** pin "Prefers async updates over meetings" → retrievable by a related query; `model_calls` shows the embed call.
**Tests:** retrieval ranking sanity on seeded vectors; lifecycle filter; `last_used_at` touch.

### MC-202 · ContextPacket service
`core/context`: assemble per ARCHITECTURE §6 — date/schedule (today's `calendar_events`), open commitments ranked (due date asc, then age, then counterparty recency), top-k memories (vector vs. a task-shaped query + pinned always), related episodes (last 24 h), preferences, safety/format instructions; persisted to `context_packets`; size budget enforced (token-count cap with deterministic truncation order, truncations recorded in packet meta).
**AC:** packet JSON inspectable per brief; same inputs → byte-identical packet (determinism for caching + evals).
**Tests:** ranking order; truncation order; determinism snapshot.

### MC-203 · Real morning brief
Replace hello-brief content: `cos.morning_brief` prompt + Zod schema (sections: top commitments, today's schedule w/ prep pointers, waiting-fors to nudge — *as drafts*, slipped items), top tier; renderer JSON→md/HTML for reader + email; reader upgrade (sections, links to commitments/people); `opened_at` set on first authenticated view (and `user_actions` `brief_opened`); "why did you say this?" debug view (brief → packet → source rows).
**AC:** 7 AM brief reflects real ledger + calendar; tapping push → reader → `opened_at` set exactly once; debug view walks to a source email excerpt.
**Tests:** renderer snapshots; `opened_at` idempotency; generation failure → failed run + **no** brief row + no notify.

### MC-204 · Delivery hardening
`notify` records `pushed_at`/`emailed_at` per channel with independent failure handling (push can fail while email succeeds — partial failure is a visible degraded state, not a job failure); retry policy per channel; subscription pruning surfaced in settings ("push broken on iPhone since …"); daily-cost ticker on `/runs` (sum `model_calls.cost_usd` today vs. ceiling from preferences).
**AC:** disable push at OS level → email still arrives, settings shows push unhealthy; cost ticker matches a SQL spot-check.
**Tests:** partial-failure matrix; pruning state machine; cost aggregation.

---

## Epic E3 — Meeting Prep (Phase 3)

### MC-301 · Meeting flagging
Default rule: flag events with ≥1 non-owner attendee; manual flag/unflag toggle on a `/calendar` list view; rule config in `user_preferences`; flags survive event updates.
**AC:** external meeting auto-flags; solo focus block doesn't; manual override sticks across a resync.
**Tests:** rule evaluation matrix; flag persistence through upsert.

### MC-302 · T−45 scheduler
Scan job maintains delayed `briefs` jobs (jobId `meeting_prep:<gcal_event_id>`) at `starts_at − 45 min` for flagged future events; reschedule on time change, cancel on unflag/cancellation; skip if T−45 already past (generate immediately if meeting still ≥10 min out).
**AC:** move a flagged meeting +2 h → packet time moves; cancel → no packet; flag a meeting starting in 20 min → packet now.
**Tests:** schedule/reschedule/cancel state machine against fixture event mutations; the ≥10-min edge.

### MC-303 · Person context enrichment
Attendee→person resolution hardening (multi-email identities, name backfill from headers/attendee display names); person detail page: open mutual commitments both directions, recent episodes, `last_contact_at`, notes.
**AC:** person page for a frequent counterparty shows an accurate mutual picture; two emails for one human resolve to one person row.
**Tests:** resolution merge rules; person-page queries.

### MC-304 · Prep packet generation
`cos.meeting_prep` prompt + schema: who's attending (relationship context), open mutual commitments, what was last discussed (episodes), suggested talking points *as drafts*; packet→generate→deliver via the existing pipeline (`kind='meeting_prep'`, dedupe `meeting_prep:<event_id>`); push copy includes meeting title + time.
**AC:** the BUILD-PLAN Phase-3 exit scenario end-to-end on a real meeting.
**Tests:** packet recipe for meeting context; dedupe on event reschedule (regenerate policy: cancel-then-new jobId carries a `:2` suffix — second packet allowed, both traceable).

---

## Epic E4 — Full Cadence (Phase 4)

### MC-401 · Reconciliation v2
Nightly `reconcile` job: candidate matches between last-24 h episodes and open commitments (heuristics: same counterparty + reply-thread linkage + embedding similarity of episode↔commitment text); writes `reconciliation_proposals` rows (`done` / `slipped` / `contradicted`, with `evidence_episode_id`, rationale, confidence, `proposed_changes`) surfaced as a distinct confirmation-queue section — never auto-closes. A disposition resolves the proposal row (`accepted`/`rejected` + `resolved_at`), writes `user_actions`, and only an accepted proposal updates commitment status.
**AC:** reply "got it, sent the deck" on a tracked thread → next morning the queue proposes closing that commitment; one tap closes with `resolved_at`.
**Tests:** matcher precision on fixture pairs; proposal-not-autoclose invariant (no commitment status change without a resolved proposal + `user_actions` row); nightly re-run converges (dedupe on same evidence).

### MC-402 · EOD Close
`cos.eod_close` (4:30 PM MT workdays): what closed today, what slipped, tomorrow teed up (calendar + due commitments); same pipeline; workday gating from preferences.
**AC:** EOD brief accurate against the day's actual dispositions; suppressed on weekends.
**Tests:** packet recipe (day-window queries); workday gate.

### MC-403 · Weekly Review
`cos.weekly_review` (Sunday 7 PM MT): full readout — week's closed/slipped/aging commitments, counterparty balance (who owes you / who you owe most), next-week calendar shape, memory highlights; longer-form render.
**AC:** Sunday artifact reads as a genuine chief-of-staff readout over real week data.
**Tests:** week-window aggregation queries; renderer snapshot.

### MC-404 · Memory review queue
Surface memories where `review_at <= now` (and stale `last_used_at` candidates for `warm`/`archive`) in a review UI: keep / edit / archive / delete (soft, `status='deleted'`); dispositions logged.
**AC:** an aged memory appears for review; archive removes it from retrieval (MC-201 filter) verifiably.
**Tests:** queue query; lifecycle transitions; retrieval exclusion.

### MC-405 · Graduation-gate dashboard
`/gate`: metric 1 brief-open-within-1 h rate over trailing 30 workdays (`opened_at` vs `generated_at`); metric 2 captured-then-dropped count (confirmed commitments that hit a terminal state without disposition — should be structurally ~0, the metric proves it); metric 5 `docs/INSIGHTS.md` entry count (parsed at build or via a simple counter); daily cost trend.
**AC:** dashboard live against real data; numbers match manual SQL.
**Tests:** metric queries against seeded scenarios (incl. the ≥80% threshold arithmetic).

---

## Cross-cutting tickets (slot when needed, not blocking)

### MC-901 · Append-only hardening
Enforce the lifecycle-column exception at the DB level (SCHEMA.md §3.6): `REVOKE DELETE` on all four activity tables; `REVOKE UPDATE` on `model_calls` + `user_actions`; column-level `GRANT UPDATE` for the lifecycle columns on `cadence_runs` + `run_steps`. One migration + role split. Do after Phase 1 once write paths are stable.

### MC-902 · Backup verification
Confirm Railway Postgres backup schedule; document restore drill in `docs/RUNBOOK.md`; perform one restore to a scratch DB. Do before Phase 2 (real personal data lands in Phase 1).
