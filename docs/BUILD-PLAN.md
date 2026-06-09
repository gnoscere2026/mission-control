# Mission Control — Phased Build Plan (v1)

**Deliverable §9.3** · phases from [PLANNING-BRIEF.md §9.3](PLANNING-BRIEF.md); architecture in [ARCHITECTURE.md](ARCHITECTURE.md); tickets in [BACKLOG.md](BACKLOG.md).

Sizing unit: a **weekend session** = one sitting of Claude Code implementation + human review, roughly 2–4 focused hours. Every phase ends **shipped and in daily use** — no phase is "done" while it only works locally. Each phase's exit criteria are written so Mark can verify them on his phone, not in a terminal.

| Phase | Name | Sessions | Ships |
|---|---|---|---|
| 0 | Walking Skeleton | 2 | A trivial 7 AM brief, pushed + emailed, from production infra |
| 1 | Ledger | 3 | Real ingest → extraction → confirmation queue, with the eval harness live |
| 2 | Morning Brief | 2 | The real brief: context assembly, generation, `opened_at` |
| 3 | Meeting Prep | 2 | T−45 prep packets for flagged meetings |
| 4 | EOD + Weekly + Reconciliation | 3 | The full cadence loop |

Cross-phase rules (from brief §11, enforced via CLAUDE.md): plan mode before each epic; migrations applied and activity-log coverage verified at every session end; eval run whenever extraction is touched; `docs/INSIGHTS.md` updated when product learning occurs.

---

## Phase 0 — Walking Skeleton (2 sessions)

**Goal:** end-to-end plumbing proven before any intelligence. One BullMQ repeatable job generates a trivial "hello" brief at 7:00 AM MT, writes it through the real schema, pushes it to the installed PWA, and mirrors it to email — from Railway, not localhost.

- **Session 0.1 — Repo + local stack** (MC-001…003): npm-workspaces monorepo, `packages/db` with migration 0000 (full schema from SCHEMA.md — it exists, ship it whole), docker-compose Postgres+Redis, Next.js app with auth-lite session, worker skeleton with BullMQ + `cadence_runs` bracketing.
- **Session 0.2 — Deploy + hello brief** (MC-004…006): Railway (web, worker, Redis, Postgres), CI (typecheck/lint/test/migration-check), the 7 AM hello-brief job with deterministic jobId, email mirror via SMTP, web push + service worker + iOS install page, minimal brief reader.

**Exit criteria:** (1) At 7:00 AM MT a push lands on Mark's installed iPhone PWA *and* the mirror email arrives. (2) Killing the worker mid-run and restarting produces no duplicate brief (jobId idempotency observed). (3) A forced job failure shows red on the run-health page. (4) CI green on main; deploy is `git push`.

**Deliberately absent:** Google, LLM calls, real content. If this phase is hard, that difficulty was going to be paid eventually — better now.

---

## Phase 1 — Ledger (3 sessions)

**Goal:** the spine. Gmail/GCal read-only ingest → episodes → commitment extraction → confirmation queue UI → eval harness. The brief's make-or-break ML problem (§5) gets its harness in the same phase as its first prompt, not later.

- **Session 1.1 — Google ingest** (MC-101…103): OAuth connect (read-only scopes), sealed-box token storage, Gmail History-API sync with cursor + 404 fallback, GCal sync into `calendar_events` + episodes. Idempotency tests (replay a sync window → zero new rows).
- **Session 1.2 — Extraction + LLM layer** (MC-104, MC-107): `packages/llm` `complete()` with tier routing, Anthropic adapter, Zod→forced-tool-use, schema-feedback retry, `model_calls` cost records; extraction prompt v1 + schema; candidates written with `extraction_hash` idempotency; run-health page reads real runs.
- **Session 1.3 — Confirmation queue + eval harness** (MC-105, MC-106): one-tap confirm/edit/reject UI writing `user_actions` + `extraction_labels`; eval harness per [EVAL-SPEC.md](EVAL-SPEC.md) — anonymized fixture set (≥25 fixtures to start), precision/recall runner, baseline recorded in `prompt_versions`.

**Exit criteria:** (1) An email Mark sends himself containing a promise appears as a candidate in the queue within 15 minutes. (2) Confirm/reject each write a label row. (3) `npm run eval` prints precision/recall for prompt v1 against fixtures and records to `prompt_versions`. (4) Every model call visible in `model_calls` with cost. (5) Week-2 precision may be mediocre — that's expected; the number being *visible and movable* is the criterion.

---

## Phase 2 — Morning Brief (2 sessions)

**Goal:** the first habit-forming artifact. Context assembly → top-tier generation → push + mirror → `opened_at`.

- **Session 2.1 — Context assembly + memories** (MC-201, MC-202): `embed()` in `packages/llm` (Voyage), `memories` writes (manual pin + capture), ContextPacket service (date/schedule, ranked open commitments, vector+recency memories, related episodes, preferences, safety/format instructions), packets persisted.
- **Session 2.2 — Real brief** (MC-203, MC-204): morning-brief job replaces hello-brief — Opus generation against the packet, structured `content_json` + rendered `content_md`, brief reader upgrade, `opened_at` on view, delivery hardening (`pushed_at`/`emailed_at`, push-failure handling, subscription pruning).

**Exit criteria:** (1) The 7 AM brief contains Mark's actual open commitments ranked sensibly and today's calendar. (2) Tapping the push opens the brief and sets `opened_at`. (3) Any brief can answer "why did you say this?" by walking brief → packet → sources in the UI (a debug view is fine). (4) Graduation-gate metric 1 (brief opened within 1 h on ≥80% of workdays) is now *measurable* from `opened_at`.

---

## Phase 3 — Meeting Prep (2 sessions)

**Goal:** prep packets ~45 min before flagged meetings, with person/relationship context.

- **Session 3.1 — Flagging + scheduling** (MC-301, MC-302): flag rules (external attendees by default + manual toggle in the calendar list), T−45 delayed-job scheduler keyed `meeting_prep:<gcal_event_id>` with reschedule/cancel on event change.
- **Session 3.2 — Packet + person context** (MC-303, MC-304): person resolution from attendee emails (auto-create `people`, update `last_contact_at`), prep-packet generation (counterparty commitments owed both directions, recent episodes, memories), push delivery.

**Exit criteria:** (1) A flagged 2 PM meeting produces a push at ~1:15 PM with attendee context and open mutual commitments. (2) Moving the meeting reschedules the packet; cancelling cancels it. (3) Unflagged meetings produce nothing.

---

## Phase 4 — EOD Close + Weekly Review + Reconciliation maturity (3 sessions)

**Goal:** the full chief-of-staff cadence (§2.5 complete), reconciliation that actually closes loops, and the memory review queue.

- **Session 4.1 — Reconciliation v2** (MC-401): nightly job matches new episodes against open commitments (done? slipped? contradicted?) producing *proposals* into the confirmation queue — never auto-closing (invariant 4).
- **Session 4.2 — EOD Close** (MC-402): 4:30 PM workdays — what closed, what slipped, tomorrow teed up; same packet→generate→deliver pipeline, new task + prompt.
- **Session 4.3 — Weekly Review + memory queue + gate instrumentation** (MC-403…405): Sunday 7 PM full readout; memory review queue surfacing `review_at` items; graduation-gate dashboard (brief-open rate, captured-then-dropped count, insight count).

**Exit criteria:** (1) All seven §2.5 jobs run on schedule for a full week with failures (if any) visible in-app. (2) A commitment fulfilled by a reply email gets proposed as done within a day and closes with one tap. (3) The gate dashboard reports metrics 1, 2, and 5 from brief §8 continuously.

---

## After Phase 4

Six months of User Zero operation against the §8 graduation gate. Backlog beyond this plan (second persona, design partners, auto-accept thresholds earned from measured precision) accumulates in `docs/INSIGHTS.md` and the PRD — not here.
