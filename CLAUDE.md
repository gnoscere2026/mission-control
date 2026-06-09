# Mission Control — CLAUDE.md

Single-user ("Mark") proactive chief-of-staff engine. **Read order for context:** `docs/PLANNING-BRIEF.md` (scope, locked decisions — do not relitigate §2, do not build §3 non-goals) → `docs/ARCHITECTURE.md` → the ticket in `docs/BACKLOG.md`.

## Repo shape

npm workspaces: `apps/web` (Next.js App Router, PWA), `apps/worker` (BullMQ cadence engine), `packages/db` (Drizzle + migrations), `packages/core` (domain services, prompts, schemas), `packages/llm` (the only place provider SDKs may be imported), `evals/` (extraction eval harness).

## Commands

```sh
docker compose up -d           # local Postgres(pgvector) + Redis
npm run dev                    # web (apps/web)
npm run dev:worker             # worker
npm run db:generate            # drizzle-kit generate (after schema edits)
npm run db:migrate             # apply migrations (also runs on Railway release)
npm run db:seed                # idempotent single-user seed
npm run typecheck && npm run lint && npm test
npm run eval -- --task cos.extract_commitments   # eval harness (see docs/EVAL-SPEC.md)
```

Never use `drizzle-kit push` outside a throwaway local DB. Deploy = push to `main` (Railway).

## Working agreement (brief §11)

- **Plan mode first for every epic/ticket.** No code before an approved plan.
- Small, reviewable increments — one ticket per session, one PR per ticket.
- Tests are **required** for extraction and reconciliation logic. Fixtures must be anonymized (see `docs/EVAL-SPEC.md` §anonymization) **before** commit — real names, emails, company names never land in git.
- Update `docs/INSIGHTS.md` whenever product learning occurred (a prompt behavior, a UX friction, a precision observation). This file is a graduation-gate metric; treat entries as deliverables.

## Invariants — violating any of these is a wrong implementation

1. **`owner_id` on every table and in every query.** No ownerless query helpers.
2. **Activity log is append-only.** No DELETE ever; content columns are never rewritten. Only `append*` writers in `packages/core`. Single exception: named lifecycle columns transition once, via the bracketing/delivery helpers — `cadence_runs` (`status`, `finished_at`, `error`), `run_steps` (`status`, `finished_at`, `detail`), `briefs` (`opened_at`, `pushed_at`, `emailed_at`). `model_calls` and `user_actions` are strictly insert-only.
3. **All model/embedding calls go through `packages/llm`** (`complete()` / `embed()`), which writes the cost-tracked `model_calls` row. Importing a provider SDK anywhere else fails lint.
4. **Level-2 autonomy.** The system drafts; it never sends email (except the brief mirror to the owner), never writes to Google, never takes external action. Google scopes stay `gmail.readonly` + `calendar.readonly` — a test asserts the scope list.
5. **Commitment state advances only by user disposition.** Extraction → `candidate`; reconciliation → proposals; only a `user_actions`-logged disposition changes status.
6. **Jobs are idempotent.** Deterministic BullMQ jobIds; upsert-by-source-ref; re-running any job converges.
7. **No silent failures.** Terminal job failures write failed `cadence_runs` rows; degraded delivery (push fails, email succeeds) is recorded per channel. Never swallow with a bare catch-and-log.

## Definition of done (every session)

- [ ] Migrations generated, committed, applied locally; CI migration + drift checks green
- [ ] New write paths covered by the activity log (which `cadence_runs`/`user_actions`/`model_calls` rows does this produce? — name them in the PR)
- [ ] Error visibility verified: force the failure path once, see it on `/runs`
- [ ] **If extraction prompts/schemas were touched:** `npm run eval` run, results in `prompt_versions`, P/R vs. baseline stated in the PR
- [ ] Typecheck, lint, tests green; `docs/INSIGHTS.md` updated if anything was learned

## Conventions

- Status/kind columns are `text` (+ CHECK for closed domains) — never Postgres enums.
- LLM task names are persona-namespaced: `cos.*` (chief of staff), `embed.*`. Tiers (`cheap`/`mid`/`top`/`embed`) map to models only in `packages/llm` config.
- Artifact attribution: `agent_key` on briefs, packets, runs, model calls, prompt versions (default `'chief_of_staff'`).
- Prompts + their Zod schemas live together in `packages/core/<area>/`, versioned as modules (`extract_commitments.v2.ts`); the active version is referenced in exactly one config place.
- Timestamps `timestamptz`; schedule crons in `America/Denver`.
- Secrets only via env (`.env` git-ignored; keep `.env.example` current). OAuth tokens are sealed-box encrypted — never log decrypted tokens or raw email bodies.
- UI: function over form. No design polish tickets exist; don't gold-plate.
