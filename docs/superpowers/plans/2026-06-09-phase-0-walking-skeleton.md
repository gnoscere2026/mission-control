# Phase 0 — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end plumbing proven before any intelligence — one BullMQ repeatable job generates a trivial "hello" brief at 7:00 AM MT, writes it through the real schema, mirrors it to email, pushes it to the installed PWA, with CI and a Railway deploy path. (BUILD-PLAN Phase 0, tickets MC-001…MC-006.)

**Architecture:** npm-workspaces monorepo per ARCHITECTURE.md §3: `apps/web` (Next.js App Router PWA, iron-session auth-lite), `apps/worker` (BullMQ cadence engine + delivery), `packages/db` (Drizzle schema transcribed verbatim from SCHEMA.md §2 + migrations), `packages/core` (activity-log writer, brief services, email render), `packages/llm` + `evals/` (stubs only in Phase 0). Postgres(pgvector) + Redis via docker-compose locally, Railway in prod.

**Tech Stack:** TypeScript 5, Next.js 15 (App Router), Drizzle ORM + drizzle-kit, `pg`, BullMQ 5 + ioredis, iron-session, nodemailer, web-push, Vitest 3, ESLint 9 flat config + Prettier, GitHub Actions.

**Phase-0 invariant notes (from CLAUDE.md):**
- Every table/query carries `owner_id`. The worker resolves the single owner from `USER_EMAIL` env at startup.
- Activity log writers live only in `packages/core` (`append*` + the once-only lifecycle closes).
- No LLM calls, no Google, no real content in Phase 0.
- Statuses are `text` + CHECK, crons in `America/Denver`, timestamps `timestamptz`.
- Idempotency is two-layer: deterministic BullMQ jobId (`morning-brief:<YYYY-MM-DD>`) + DB dedupe (`briefs_dedupe_ux` on `(owner_id, agent_key, dedupe_key)`).

**Human-only steps (cannot be done by the agent — collected in `docs/DEPLOY.md`):** Railway project creation + env vars + domains, SMTP credentials, pushing to GitHub `main`, installing the PWA on the iPhone and observing the 7 AM delivery. Everything else is code and is verified locally/CI.

---

## Task 1: MC-001 — Monorepo scaffold

**Files:**
- Create: `package.json` (root), `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.gitignore`, `.env.example`, `.nvmrc`
- Create: `apps/web/package.json`, `apps/worker/package.json`, `packages/db/package.json`, `packages/core/package.json`, `packages/llm/package.json`, `evals/package.json` (+ per-workspace `tsconfig.json`, `src/index.ts`, `vitest.config.ts`)
- Test: `packages/core/src/index.test.ts` (cross-workspace import), one placeholder test per workspace

- [ ] **Step 1: Root scaffolding**

Root `package.json` (private, workspaces `["apps/*", "packages/*", "evals"]`), scripts:

```json
{
  "name": "mission-control",
  "private": true,
  "workspaces": ["apps/*", "packages/*", "evals"],
  "scripts": {
    "dev": "npm run dev -w apps/web",
    "dev:worker": "npm run dev -w apps/worker",
    "build": "npm run build --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint": "eslint .",
    "test": "npm run test --workspaces --if-present",
    "db:generate": "npm run generate -w packages/db",
    "db:migrate": "npm run migrate -w packages/db",
    "db:seed": "npm run seed -w packages/db",
    "db:studio": "npm run studio -w packages/db",
    "eval": "npm run eval -w evals"
  },
  "engines": { "node": ">=22" }
}
```

`tsconfig.base.json`: `strict: true`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `target: "ES2022"`, `skipLibCheck: true`, `declaration: true`. Workspace packages use names `@mission-control/db|core|llm`. Each workspace `src/index.ts` exports at least a named const so imports resolve. ESLint 9 flat config: `typescript-eslint` recommended, ignores `**/.next/**`, `**/dist/**`, `**/migrations/**`. `.env.example` starts with `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `SESSION_PASSWORD`, `USER_EMAIL`, `USER_NAME`.

- [ ] **Step 2: Placeholder test per workspace** — e.g. `packages/core/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CORE_PACKAGE } from "./index";
describe("workspace wiring", () => {
  it("resolves workspace import", () => expect(CORE_PACKAGE).toBe("@mission-control/core"));
});
```

`apps/worker` placeholder imports from `@mission-control/core` to prove cross-workspace resolution. `apps/web` typecheck uses `next typegen`-free setup: commit standard `next-env.d.ts` (added in Task 6; web gets a plain placeholder test now).

- [ ] **Step 3: Verify AC** — `npm i && npm run typecheck && npm run test` green from clean state.
- [ ] **Step 4: Commit** — `feat(MC-001): monorepo scaffold with workspaces, lint, vitest`

## Task 2: MC-002 — `packages/db`: schema + client

**Files:**
- Create: `packages/db/src/schema/auth.ts`, `schema/domain.ts`, `schema/artifacts.ts`, `schema/activity.ts`, `schema/evals.ts`, `schema/index.ts`, `src/client.ts`, `drizzle.config.ts`

- [ ] **Step 1: Transcribe schema verbatim** from SCHEMA.md §2.1–2.5 into the five files (SCHEMA.md is the source of truth; fix only unused-import lint). `schema/index.ts` re-exports all. Note `artifacts.ts` `cadenceRunId` stays a bare uuid column (comment says FK ordering — keep as written).
- [ ] **Step 2: Client factory** `src/client.ts`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}
export type Db = ReturnType<typeof createDb>["db"];
export * from "./schema";
```

- [ ] **Step 3: `drizzle.config.ts`** — dialect `postgresql`, schema `./src/schema/index.ts`, out `./migrations`, url from `DATABASE_URL`.
- [ ] **Step 4: Typecheck green; commit** — `feat(MC-002): drizzle schema transcribed from SCHEMA.md + client factory`

## Task 3: MC-002 — Local stack, migration 0000, seed, tests

**Files:**
- Create: `docker-compose.yml`, `packages/db/migrations/0000_*.sql` (generated, hand-edited), `packages/db/src/migrate.ts`, `src/seed.ts`
- Test: `packages/db/src/migrate.test.ts`

- [ ] **Step 1: `docker-compose.yml`** — `pgvector/pgvector:pg17` on 5432 (db `mission_control`), `redis:7-alpine` on 6379, volumes.
- [ ] **Step 2: Generate migration 0000** (`npm run db:generate`), then hand-prepend `CREATE EXTENSION IF NOT EXISTS vector;` (SCHEMA.md §3.2). Never `drizzle-kit push`.
- [ ] **Step 3: Migrate runner** `src/migrate.ts` using `drizzle-orm/node-postgres/migrator` `migrate(db, { migrationsFolder })`, invoked by `npm run migrate` (tsx). Exits non-zero on failure.
- [ ] **Step 4: Seed** `src/seed.ts` — insert `users` row from `USER_EMAIL`/`USER_NAME` env, `onConflictDoNothing({ target: users.email })`. Idempotent by construction.
- [ ] **Step 5: Integration test** (requires `DATABASE_URL`, provided by docker locally / service container in CI): fresh-apply migrations onto the compose Postgres is exercised by running `migrate()` twice (second run no-op, journal-tracked) and `seed()` twice asserting exactly one `users` row.
- [ ] **Step 6: Verify AC** — `docker compose up -d && npm run db:migrate && npm run db:seed` then re-run migrate → no-op. Spot-check tables in psql.
- [ ] **Step 7: Commit** — `feat(MC-002): migration 0000 (pgvector), docker stack, idempotent seed`

## Task 4: MC-003 — `packages/core` activity-log writer + `withCadenceRun`

**Files:**
- Create: `packages/core/src/activity/cadence-runs.ts`, `src/activity/index.ts`
- Test: `packages/core/src/activity/cadence-runs.test.ts`

- [ ] **Step 1: Failing tests** — `withCadenceRun` writes `running→succeeded` (with `finished_at`), and on thrown error writes `running→failed` with `error` text and rethrows.
- [ ] **Step 2: Implement (only `append*` + once-only close, CLAUDE.md invariant 2):**

```ts
export async function openCadenceRun(db: Db, args: { ownerId: string; jobName: string; jobId: string; attempt?: number; agentKey?: string }): Promise<string>; // INSERT, returns id
export async function closeCadenceRun(db: Db, runId: string, outcome: "succeeded" | "failed", error?: string): Promise<void>; // UPDATE status/finished_at/error WHERE id AND status='running' (once-only)
export async function withCadenceRun<T>(db: Db, args: OpenArgs, fn: (runId: string) => Promise<T>): Promise<T>;
```

`withCadenceRun`: open → `fn(runId)` → close succeeded → return; catch → close failed with `String(err)` → rethrow. No bare catch-and-log.
- [ ] **Step 3: Tests green; commit** — `feat(MC-003): cadence_runs bracketing helper (append-only writer)`

## Task 5: MC-003 — Worker skeleton

**Files:**
- Create: `apps/worker/src/index.ts`, `src/env.ts`, `src/queues.ts`, `src/owner.ts`, `src/jobs/stub.ts`

- [ ] **Step 1: Queue registry** per ARCHITECTURE §5.1 — queues `ingest`, `extraction`, `reconciliation`, `briefs`, `notify` declared over one ioredis connection (`maxRetriesPerRequest: null`); handlers stubbed (briefs/notify get real handlers in Tasks 8–9; the rest throw `not implemented in Phase 0` only if somehow enqueued — nothing enqueues them).
- [ ] **Step 2: Owner resolution** — `resolveOwner(db)` selects the `users` row by `USER_EMAIL`; worker refuses to start without it (loud failure, not silent).
- [ ] **Step 3: Repeatables + lifecycle** — `Queue.upsertJobScheduler` registrations (morning-brief tick added in Task 8), default job opts `attempts: 5`, exponential backoff base 30s (ARCHITECTURE §5.2). Graceful shutdown: SIGTERM/SIGINT → `worker.close()` all workers, `pool.end()`, `connection.quit()`.
- [ ] **Step 4: Stub-job test** — run a stub handler wrapped in `withCadenceRun` against local DB; assert a succeeded `cadence_runs` row (AC).
- [ ] **Step 5: Commit** — `feat(MC-003): worker skeleton — queue registry, owner resolution, graceful shutdown`

## Task 6: MC-003 — Web skeleton + auth-lite

**Files:**
- Create: `apps/web/app/layout.tsx`, `app/page.tsx`, `app/login/page.tsx`, `app/api/login/route.ts`, `app/api/health/route.ts`, `src/session.ts`, `src/db.ts`, `middleware.ts`, `next.config.ts`, `next-env.d.ts`
- Test: `apps/web/src/session.test.ts`, `app/api/login/route.test.ts`

- [ ] **Step 1: Session helper** (`iron-session`): cookie `mc_session`, payload `{ ownerId: string }`, password `SESSION_SECRET` (≥32 chars), `secure` in prod. `getOwnerId()` → redirect/401 when absent. **No ownerless query helper exists:** `src/db.ts` exposes only `forOwner(ownerId)`-shaped helpers.
- [ ] **Step 2: Login** — page posts shared secret; route handler timing-safe-compares against `SESSION_PASSWORD`, looks up the seeded user, saves session. Wrong secret → 401, no cookie.
- [ ] **Step 3: Gating** — `middleware.ts` redirects unauthenticated page requests to `/login` (public: `/login`, `/api/login`, `/api/health`, static assets, `/sw.js`, manifest). `/api/health` returns `{ ok: true }` plus a cheap `SELECT 1`.
- [ ] **Step 4: Tests** — login round-trip: correct secret → `Set-Cookie`; wrong → 401 (AC: wrong secret → no session).
- [ ] **Step 5: Commit** — `feat(MC-003): Next.js app, iron-session auth-lite, health endpoint, route gating`

## Task 7: MC-004 — CI + deploy config + runbook

**Files:**
- Create: `.github/workflows/ci.yml`, `apps/web/railway.json`, `apps/worker/railway.json`, `docs/DEPLOY.md`

- [ ] **Step 1: CI workflow** — on push/PR to `main`; Postgres (`pgvector/pgvector:pg17`) + Redis service containers; steps: `npm ci`, **typecheck**, **lint**, **migration check** (run `db:migrate` against the clean service container — this is the clean-postgres apply), **drift check** (`npm run db:generate` then `git diff --exit-code` + fail on untracked files under `packages/db/migrations`), **test** (env: `DATABASE_URL`, `REDIS_URL` pointing at services; migrate + seed first). Five required checks (MC-004 AC).
- [ ] **Step 2: Railway config-as-code** — per-service `railway.json`: web `buildCommand: npm ci && npm run build -w apps/web`, `startCommand: npm run start -w apps/web`, worker `startCommand: npm run start -w apps/worker`, both `preDeployCommand: npm run db:migrate`. Watch paths scoped to each app + packages.
- [ ] **Step 3: `docs/DEPLOY.md`** — exact human steps: create Railway project, add Postgres (pgvector image) + Redis, two services from repo subpaths, set env (`DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `SESSION_PASSWORD`, `TOKEN_SEAL_KEY` (reserved), `USER_EMAIL`, `USER_NAME`, `SMTP_*`, `MAIL_FROM`, `MAIL_TO`, `VAPID_*`, `NEXT_PUBLIC_APP_URL`), connect GitHub repo, verify `/api/health`, worker logs show schedulers registered. Includes the Phase-0 exit-criteria verification checklist (push + email at 7 AM, kill-worker idempotency drill, forced-failure red row, CI green).
- [ ] **Step 4: Commit** — `feat(MC-004): CI (typecheck/lint/test/migration/drift), Railway config, deploy runbook`

## Task 8: MC-005 — Hello brief job

**Files:**
- Create: `packages/core/src/briefs/hello.ts` (service: packet + brief insert), `apps/worker/src/jobs/morning-brief.ts`
- Test: `packages/core/src/briefs/hello.test.ts` (dedupe double-run)

- [ ] **Step 1: Failing test** — `generateHelloBrief(db, { ownerId, date })` twice for the same date → exactly one `briefs` row and one `context_packets` row used; second call returns `{ created: false }`.
- [ ] **Step 2: Implement service** — insert `context_packets` (`task: "cos.morning_brief"`, trivial content `{ hello: true, date }`), insert `briefs` `kind='morning'`, `dedupeKey = morning:<date>`, placeholder `contentJson` + `contentMd` ("Hello from Mission Control — walking skeleton…"), `onConflictDoNothing` on the dedupe unique index; only a *newly created* brief triggers notify. (Order packet-then-brief; an orphan packet on conflict is harmless traceability data.)
- [ ] **Step 3: Worker wiring** — scheduler `morning-brief-tick` (`pattern: 0 7 * * *`, `tz: America/Denver`) on `briefs` queue; tick handler computes today (`America/Denver`) and enqueues `briefs` job `{ name: 'morning_brief', jobId: 'morning-brief:<YYYY-MM-DD>' }` — deterministic jobId makes crash-restart a no-op (exit criterion 2). Handler: `withCadenceRun('morning_brief', jobId)` → service → if created, enqueue `notify` `{ jobId: 'notify:<briefId>' }`.
- [ ] **Step 4: Tests green; commit** — `feat(MC-005): hello morning-brief job with two-layer idempotency`

## Task 9: MC-005 — Email mirror + failure visibility

**Files:**
- Create: `packages/core/src/briefs/render.ts`, `packages/core/src/briefs/delivery.ts` (once-only `markBriefEmailed`/`markBriefPushed`), `apps/worker/src/delivery/email.ts`, `apps/worker/src/jobs/notify.ts`
- Test: render snapshot; SMTP-failure → failed `cadence_runs` row

- [ ] **Step 1: Renderer + snapshot test** — `renderBriefEmail(brief)` → `{ subject, text }` plain render of `contentMd`; Vitest snapshot.
- [ ] **Step 2: Notify handler** — `withCadenceRun('notify', jobId)`: load brief; send email via nodemailer (SMTP env); on success `markBriefEmailed(db, briefId)` (sets `emailed_at` only when null). SMTP throw propagates → failed run row (test with a transport mock that rejects — **no swallowed errors**). Push channel slots in Task 11; per-channel results recorded in run `meta` (degraded delivery visible, invariant 7).
- [ ] **Step 3: Tests green; commit** — `feat(MC-005): email mirror with visible failure path`

## Task 10: MC-005 — Brief reader UI

**Files:**
- Create: `apps/web/app/briefs/page.tsx` (list, newest first), `app/briefs/[id]/page.tsx` (reader rendering `contentMd`), `app/runs/page.tsx` (minimal run-health list: latest runs, failed rows styled red — full page is MC-107, this is the Phase-0 "red row" surface)

- [ ] **Step 1: Pages** — server components querying via owner-scoped helpers; brief reader shows kind/date/content. Function over form.
- [ ] **Step 2: Manual verify** — seed a brief via the job (manual tick trigger script `npm run trigger:brief -w apps/worker`), read it at `/briefs/[id]`; force SMTP failure once and see the red row on `/runs` (CLAUDE.md DoD).
- [ ] **Step 3: Commit** — `feat(MC-005): brief list/reader + minimal run-health page`

## Task 11: MC-006 — Web push + PWA install

**Files:**
- Create: `apps/web/public/manifest.webmanifest`, `public/sw.js`, `public/icons/*`, `app/api/push/subscribe/route.ts`, `app/settings/page.tsx` (+ small client component), `apps/worker/src/delivery/push.ts`
- Test: subscribe-endpoint validation; sender sets `pushed_at`; pruning (404/410 → `failure_count`+1, `disabled_at` after 5)

- [ ] **Step 1: PWA assets** — manifest (name, standalone, icons), `sw.js`: `push` → `showNotification(title, { body, data: { url } })`; `notificationclick` → `clients.openWindow(data.url)`.
- [ ] **Step 2: Subscribe endpoint** — validates `{ endpoint, keys: { p256dh, auth } }` (400 otherwise), upserts `push_subscriptions` on `(ownerId, endpoint)`, resets `failure_count`/`disabled_at` on re-subscribe. Settings page: notification-permission flow, `pushManager.subscribe` with `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, iOS Safari detection → Add-to-Home-Screen instructions (ARCHITECTURE §2.4).
- [ ] **Step 3: Push sender (worker)** — failing tests first against a mocked `web-push`: sends to all non-disabled subscriptions; any success → `markBriefPushed`; per-sub 404/410 → increment `failure_count`, set `disabled_at` when it reaches 5, record per-channel outcome in run meta (push failing while email succeeds = degraded, not job failure). Wire into the Task-9 notify handler.
- [ ] **Step 4: Tests green; commit** — `feat(MC-006): VAPID web push, service worker, subscribe + pruning, iOS install flow`

## Task 12: Phase-0 close-out

- [ ] **Step 1: Full local drill** — `docker compose up -d`, migrate, seed, `npm run dev` + `npm run dev:worker`; trigger brief manually; verify: brief row + reader, email attempt recorded, double-trigger creates nothing, kill-worker-mid-run + restart converges, forced failure red on `/runs`.
- [ ] **Step 2: DoD sweep** — typecheck/lint/test green; `.env.example` complete; new write paths named (cadence_runs: `morning_brief`, `notify`; briefs lifecycle: `emailed_at`/`pushed_at`); update `docs/INSIGHTS.md` with anything learned.
- [ ] **Step 3: Commit + hand off `docs/DEPLOY.md`** human checklist (Railway, SMTP, VAPID keys via `npx web-push generate-vapid-keys`, iPhone install, 7 AM observation).

## Self-review notes

- Spec coverage: MC-001 (Task 1), MC-002 (2–3), MC-003 (4–6), MC-004 (7), MC-005 (8–10), MC-006 (11), exit criteria (7, 12).
- Repeatable-scheduler vs deterministic jobId tension resolved via tick→enqueue pattern (Task 8 Step 3).
- `evals/` and `packages/llm` are deliberately stubs (BUILD-PLAN "deliberately absent").
