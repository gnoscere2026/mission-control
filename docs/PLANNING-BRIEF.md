# Mission Control — Planning Brief for Claude Code

**Version:** 1.0 · **Date:** June 2026 · **Owner:** Mark
**Purpose:** This document is the single source of truth for planning Mission Control v1. It encodes locked strategic decisions so the planning session generates architecture and backlog — not relitigated strategy.

---

## How to Use This Document

1. Create a fresh repo. Commit this file as `docs/PLANNING-BRIEF.md`.
2. Open Claude Code in the repo. Use **Opus in plan mode** for the architecture/epic planning session. Switch to **Sonnet** for ticket breakdown and implementation sessions. (Workflow reference: https://docs.claude.com/en/docs/claude-code/overview)
3. Paste the kickoff prompt below. Review and iterate on the plan **before** approving any code generation.

### Kickoff Prompt (paste into Claude Code, plan mode)

> Read `docs/PLANNING-BRIEF.md` in full. Acting as a principal architect and engineering manager for a solo founder, produce the deliverables in §9 in order. Do not relitigate the locked decisions in §2 or expand scope beyond §3. Where the brief leaves a choice open (§10), make a recommendation with a one-paragraph rationale and proceed. Optimize every plan for: (a) shippable increments completable in 1–3 weekend sessions, (b) implementation by Claude Code with human review, (c) the venture-grade vs. hack-now boundary in §2.4. Start with the architecture doc and stop for my review before producing the schema.

---

## 1. Product Thesis (Compressed)

**A chatbot waits. A chief of staff runs a cadence.**

Mission Control is a proactive operations engine with chat bolted on — the inversion of every lab product (request-response with memory bolted on). The atomic unit is not a conversation; it is a **recurring operating rhythm**: the system observes (ingests email/calendar/captures), orients (reconciles against commitments, relationships, goals), decides (prioritizes, drafts, flags), and acts only with approval — on a schedule, whether or not the user opens the app.

**The Commitment is the first-class data primitive.** Salesforce built a $300B company by making the "Opportunity" a database object everything organizes around. Mission Control does this for the commitment: the promise made in a Tuesday email thread, the waiting-for owed by a colleague, the thing said in a meeting that dies in an inbox. Task apps track what users type in; nothing tracks what they *said they'd do* across surfaces. The accumulated ledger is the moat — data no lab has and no user can churn away from.

**Phase strategy:** User Zero (Mark, 6 months, single-tenant) → design partners (consultant/client-facing-leader cohort) → venture platform. v1 is built for one user with platform bones.

## 2. Locked Decisions — Do Not Relitigate

### 2.1 Product
- **User:** One. Mark. No signup, no multi-user, no billing.
- **Wedge:** The Chief of Staff cadence loop, built in this order:
  1. **Commitment Ledger** (the spine — everything else consumes it)
  2. **Morning Brief** (~7:00 AM MT daily)
  3. **Meeting Prep Packets** (auto, ~45 min before flagged meetings)
  4. **EOD Close** (~4:30 PM MT) + **Weekly Review** (Sunday evening)
- **Autonomy ceiling: Level 2 (Draft).** The system reads, extracts, summarizes, and drafts. It NEVER sends email, writes calendar events, or takes any external action. No exceptions in v1.
- **Surface:** The product's own Next.js web app / PWA with web push notifications. One backstop: each generated brief is also mirrored to email (plain render, ~20 lines of code) as notification insurance — iOS web push requires home-screen install and the habit loop tolerates zero missed briefs.

### 2.2 Integrations (v1, complete list)
- **Gmail — read-only** (OAuth, `gmail.readonly` scope)
- **Google Calendar — read-only** (`calendar.readonly` scope)
- **Manual quick-capture** (in-app: text box + chat interface)
- Nothing else. No Slack, no task-app sync, no Notion, no voice.

### 2.3 Stack
- **Single TypeScript monorepo.** One language, one deploy story, fully legible to Claude Code in a single context.
- **Next.js (App Router)** — web app + API routes.
- **Background worker process** — the cadence engine. **BullMQ + Redis** for scheduled/repeatable jobs and queues. (Temporal is the designated graduation path if workflow durability needs outgrow BullMQ — note the trigger conditions in the risk register, don't build it now.)
- **PostgreSQL + pgvector** — relational + semantic retrieval in one database.
- **Provider-agnostic LLM layer** — thin internal interface; Anthropic models as default provider. Task-tier routing (cheap/fast model for extraction and summarization; top model for brief synthesis and planning). Per-run token/cost tracking from day 1. (Concepts port from Mark's existing multi-agent consensus engine work: routing, budget governance.)
- ORM: planner's choice (see §10).

### 2.4 The Venture-Grade vs. Hack-Now Boundary

| Venture-grade from day 1 (expensive to retrofit) | Hack shamelessly (cheap to redo) |
|---|---|
| Domain schema with `owner_id` on every table (single-tenant deploy, multi-tenant shape) | Auth: single hardcoded user behind basic protection |
| **Append-only activity log**: every ingest, extraction, model call, job run, and user action | UI polish — function over form |
| Provider-agnostic LLM layer with cost tracking | Onboarding, billing, marketing site: none |
| Approval primitives: everything the system produces is a draft/proposal with explicit user disposition | Integration breadth |
| Memory records carry `source`, `confidence`, `sensitivity`, lifecycle timestamps | Admin tooling: SQL console is fine |

### 2.5 Operating Cadence (the jobs the engine runs)

| Job | Schedule | Function |
|---|---|---|
| Ingest sync | Every 15 min, working hours | Pull new Gmail messages + calendar deltas into the event log |
| Commitment extraction | On new ingested content | Detect promises/waiting-fors; write candidates to confirmation queue |
| Reconciliation | Nightly | Match new info against open commitments (done? slipped? contradicted?) |
| Morning Brief | 7:00 AM MT daily | Generate + push + email-mirror |
| Meeting Prep | T−45 min before flagged events | Generate prep packet, push |
| EOD Close | 4:30 PM MT workdays | What closed, what slipped, tomorrow teed up |
| Weekly Review | Sunday 7:00 PM MT | Full chief-of-staff readout |

Every job run: idempotent, retried with backoff, failures visible in-app (no silent failures — a missed brief must be loudly known).

## 3. Explicit Non-Goals for v1

Skill builder / self-coding agents · skill marketplace · multi-user or household mode · BYO-model settings UI (the abstraction *layer* yes; user-facing config no) · autonomous sending or external writes of any kind · calendar write-back · task-app sync · voice · native mobile apps · enterprise anything · financial/health data. These live in the PRD as roadmap. Any plan output that includes them is wrong.

## 4. Domain Model — Starting Points

The planner should refine, not replace, these. Names matter less than relationships.

**Commitment** (the spine):
`id, owner_id, direction (owed_by_me | owed_to_me), counterparty_person_id, description, source_type (email | calendar | manual | chat), source_ref (e.g., Gmail message id), source_excerpt, due_date (nullable), due_date_basis (explicit | inferred), status (candidate | open | done | dropped | snoozed), confidence (0–1), project_tag, sensitivity, created_at, confirmed_at, last_surfaced_at, resolved_at`

**Person** (relationship-lite, not a full CRM): `id, owner_id, names/emails[], org, role, relationship_type, notes, last_contact_at`

**Episode** (append-only event log entry): `id, owner_id, occurred_at, type, source, summary, raw_ref, related_person_ids[], related_commitment_ids[]`

**Memory** (semantic facts/preferences): `id, owner_id, content, embedding, source_episode_id, confidence, sensitivity, status (active | warm | archived | deleted), created_at, last_used_at, review_at`

**Brief** (immutable generated artifact): `id, owner_id, kind (morning | eod | weekly | meeting_prep), generated_at, content (structured JSON + rendered), context_packet_ref, opened_at, model_calls_ref`

**CadenceRun / ActivityLog**: job runs, steps, model calls (provider, model, tokens, cost, latency), outcomes, errors.

**Memory scope for v1:** semantic, episodic, commitment, relationship-lite. **Deferred:** procedural, narrative, state, and goal memory (capture goals as pinned semantic memories for now).

## 5. The Hard Problem: Commitment Extraction Quality

This is the make-or-break ML problem, and it gets dedicated treatment:

- **Eval harness from week one, not month three.** A labeled fixture set built from Mark's real (anonymized-in-repo) emails; precision/recall tracked per prompt version; extraction prompts versioned in-repo and changes gated on eval runs.
- **Human-in-the-loop confirmation flow:** extracted commitments land as `candidate` status in a confirmation queue UI (one-tap confirm/edit/reject). Rejections are labeled training signal. Auto-accept above a confidence threshold is *earned* by measured precision, not assumed.
- Target trajectory: it's fine if week-2 precision is mediocre — the system's value is the loop that improves it. (Relevant prior art: Mark's RAG retrieval-precision work plateaued ~70% on Azure AI Search; design the harness so this number is visible and movable.)

## 6. Context Assembly

A `ContextPacket` service builds the input for every generation job: current date/schedule, open commitments (ranked by due/age/counterparty), relevant semantic memories (vector + recency), related episodes, user preferences, and the safety/format instructions. Packets are persisted and referenced by the artifacts they produced (full traceability: every brief can answer "why did you say this?").

## 7. Security & Privacy Floor

OAuth tokens encrypted at rest (KMS or libsodium sealed box); read-only Google scopes only; no data egress except to the model provider; activity log records what data categories each model call contained; secrets never in repo; single-user auth still gets a real session, not a query param.

## 8. Graduation Gate (defines "done" for the 6-month phase)

1. Brief opened within 1 hour on ≥80% of workdays (instrumented via `opened_at`).
2. Zero captured-then-dropped commitments.
3. The panic test: a week of downtime would materially hurt.
4. 3–5 consultant peers ask for access unprompted after seeing it.
5. Insight log (a running `docs/INSIGHTS.md`) has ≥50 entries — this is the design-partner spec and seed-deck appendix.

## 9. Deliverables Required from the Planning Session (in order)

1. **`docs/ARCHITECTURE.md`** — monorepo layout, process topology (web + worker + Redis + Postgres), data flow for one full cadence cycle, Mermaid diagrams. *Stop for review.*
2. **Database schema** — full DDL/ORM definitions for §4, with migration strategy.
3. **Phased build plan**, each phase shippable in 1–3 weekend sessions:
   - **Phase 0 — Walking Skeleton:** repo, CI, deploy, auth-lite, one BullMQ job that generates a trivial "hello" brief at 7 AM and pushes + emails it. End-to-end plumbing proven before any intelligence.
   - **Phase 1 — Ledger:** Gmail/GCal read-only ingest → event log → extraction → confirmation queue UI → eval harness.
   - **Phase 2 — Morning Brief:** context assembly → brief generation → PWA push + email mirror → `opened_at` instrumentation.
   - **Phase 3 — Meeting Prep:** flagging logic, T−45 packets, person/relationship context.
   - **Phase 4 — EOD Close + Weekly Review:** the full cadence; reconciliation maturity; memory review queue.
4. **Epics and tickets** — each ticket sized for a single Claude Code session, with acceptance criteria and test expectations.
5. **`CLAUDE.md` draft** — repo conventions, commands, definition of done (migration included, activity-log coverage, error visibility, eval run if extraction touched).
6. **Risk register** — at minimum: iOS PWA push reliability, Gmail API quotas/sync strategy, extraction precision, BullMQ→Temporal trigger conditions, model cost per day.
7. **Eval harness spec** for commitment extraction (fixtures, metrics, gating workflow).

## 10. Open Choices — Planner Recommends with Rationale, Then Proceeds

1. ORM: Drizzle vs. Prisma.
2. Hosting: the worker is a long-running process, so pure Vercel doesn't fit — recommend among Railway / Fly.io / Render / single VPS (one platform for web + worker + Redis + Postgres preferred for ops simplicity).
3. Gmail sync strategy: History API incremental sync vs. polling; quota math.
4. Web push implementation approach for the PWA (and the iOS install-to-home-screen flow).
5. Monorepo tooling: Turborepo vs. plain npm workspaces.
6. Structured output strategy for extraction (tool-use/JSON schema enforcement).

## 11. Working Agreement for Claude Code Sessions

- Plan mode first for every epic; no code before an approved plan.
- Opus for architecture/planning sessions; Sonnet for ticket implementation.
- Small, reviewable increments; tests required for extraction and reconciliation logic; fixtures anonymized before commit.
- Every session ends with: migrations applied, activity-log coverage verified, `docs/INSIGHTS.md` updated if product learning occurred.

---

*Background reference: the full category PRD (v0.1, "Mission Control Assistant Platform") exists separately and represents the long-term roadmap surface — it is explicitly NOT the build spec. This brief supersedes it for all v1 decisions.*