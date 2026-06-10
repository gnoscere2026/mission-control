# Phase 1 — Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gmail/GCal read-only ingest → episodes → commitment extraction → confirmation queue UI → eval harness (BUILD-PLAN Phase 1, tickets MC-101…MC-108).

**Architecture:** All domain logic lands in `packages/core` (shared by web + worker); the worker gains `ingest` + `extraction` queue processors; the web app gains OAuth routes, the confirmation queue, ledger, capture chat, and the upgraded run-health page; `packages/llm` gains `complete()` (the only provider-SDK import point); `evals/` gains the harness. **Zero schema changes** — migration 0000 already has every Phase 1 table.

**Tech Stack:** existing stack + `libsodium-wrappers` (sealed box), `zod@^4` (schemas + `z.toJSONSchema`), `@anthropic-ai/sdk` (inside `packages/llm` only), `bullmq` in web (enqueue-only).

**Conventions already locked (do not deviate):**
- BullMQ jobIds use `-` separators, never `:` (Phase 0 finding).
- Every job handler wraps in `withCadenceRun`; per-channel/step outcomes via `appendRunStep`.
- Every query helper takes `ownerId`. Tests are integration tests against local Postgres 5433 (CI: 5432 via `DATABASE_URL`).
- Activity tables written only via `packages/core` append* helpers; `user_actions`/`model_calls` strictly insert-only.
- Commit per ticket on branch `phase-1`: `feat(MC-1XX): …`.

**Execution context flags (check before starting):** `docker compose up -d` running; `.env` has `ANTHROPIC_API_KEY` (needed only for the MC-106 baseline run — everything else mocks the adapter). Google creds (`GOOGLE_CLIENT_ID/SECRET`) are NOT needed to build/test — OAuth flow is fetch-based and tests mock the token endpoint. Railway env updates are Mark's (note them in DEPLOY.md).

---

## Session 1.1 — Google ingest (MC-101, MC-102, MC-103)

### Task 1: Sealed-box token crypto (`core/crypto`) — MC-101

**Files:**
- Create: `packages/core/src/crypto/sealed-box.ts`, `packages/core/src/crypto/index.ts`
- Test: `packages/core/src/crypto/sealed-box.test.ts`
- Modify: `packages/core/src/index.ts` (export), `packages/core/package.json` (deps: `libsodium-wrappers`, dev `@types/libsodium-wrappers`)

- [ ] **Step 1: failing test** — round-trip; wrong key fails; missing/short env key throws a clear error.

```ts
import { describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers";
import { sealToken, unsealToken } from "./sealed-box";

const keyB64 = async () => {
  await sodium.ready;
  return sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL);
};

describe("sealed-box token crypto", () => {
  it("round-trips a token payload", async () => {
    const key = await keyB64();
    const plain = JSON.stringify({ refresh_token: "r1", access_token: "a1" });
    const sealed = await sealToken(plain, key);
    expect(sealed).not.toContain("r1");
    expect(await unsealToken(sealed, key)).toBe(plain);
  });
  it("fails to unseal with a different key", async () => {
    const sealed = await sealToken("secret", await keyB64());
    await expect(unsealToken(sealed, await keyB64())).rejects.toThrow();
  });
  it("rejects a malformed key", async () => {
    await expect(sealToken("x", "tooshort")).rejects.toThrow(/TOKEN_SEAL_KEY/);
  });
});
```

- [ ] **Step 2: implement**

```ts
import sodium from "libsodium-wrappers";

// libsodium sealed box (ARCHITECTURE §8.3). Key = base64 32-byte seed from
// TOKEN_SEAL_KEY; the curve25519 keypair is derived, never stored.
async function keypairFrom(seedB64: string | undefined) {
  await sodium.ready;
  if (!seedB64) throw new Error("TOKEN_SEAL_KEY is not set");
  let seed: Uint8Array;
  try {
    seed = sodium.from_base64(seedB64, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new Error("TOKEN_SEAL_KEY is not valid base64");
  }
  if (seed.length !== sodium.crypto_box_SEEDBYTES)
    throw new Error(`TOKEN_SEAL_KEY must decode to ${sodium.crypto_box_SEEDBYTES} bytes`);
  return sodium.crypto_box_seed_keypair(seed);
}

export async function sealToken(plain: string, key = process.env.TOKEN_SEAL_KEY): Promise<string> {
  const kp = await keypairFrom(key);
  return sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(plain), kp.publicKey),
    sodium.base64_variants.ORIGINAL,
  );
}

export async function unsealToken(sealed: string, key = process.env.TOKEN_SEAL_KEY): Promise<string> {
  const kp = await keypairFrom(key);
  const opened = sodium.crypto_box_seal_open(
    sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
    kp.publicKey, kp.privateKey,
  );
  return sodium.to_string(opened);
}
```

- [ ] **Step 3: run** `npm test -w packages/core` → green. Generate a real key into `.env` (`TOKEN_SEAL_KEY`) if empty: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- [ ] **Step 4: commit** `feat(MC-101): sealed-box token crypto in core`

### Task 2: Google OAuth module (`core/google`) — MC-101

**Files:**
- Create: `packages/core/src/google/oauth.ts`, `packages/core/src/google/tokens.ts`, `packages/core/src/google/accounts.ts`, `packages/core/src/google/index.ts`
- Test: `packages/core/src/google/oauth.test.ts`, `packages/core/src/google/tokens.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: failing tests**
  - **Scope lock (the invariant test):** `expect(GOOGLE_SCOPES).toEqual(["https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/calendar.readonly"])` — widening scopes fails this.
  - `buildGoogleAuthUrl` contains `access_type=offline`, `prompt=consent`, both scopes, the state.
  - `exchangeCode` posts grant_type=authorization_code to a mocked fetch, returns parsed tokens with computed `expiry_date`.
  - `refreshAccessToken` happy path; mocked 400 `{"error":"invalid_grant"}` throws `GoogleAuthError` with `code === "invalid_grant"`.
  - `tokens.test.ts` (DB integration): `getValidAccessToken` returns stored token when fresh; refreshes + re-seals when expired (mocked fetch, verify new ciphertext in row); on invalid_grant sets `google_accounts.status='reauth_required'` and throws `ReauthRequiredError`.

- [ ] **Step 2: implement `oauth.ts`**

```ts
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export class GoogleAuthError extends Error {
  constructor(message: string, public code: string, public status?: number) { super(message); }
}
export class ReauthRequiredError extends GoogleAuthError {
  constructor(public accountId: string, public email: string) {
    super(`Google account ${email} requires re-consent (invalid_grant)`, "invalid_grant");
  }
}

export interface GoogleTokens {
  access_token: string; refresh_token?: string; expiry_date: number; // epoch ms
  token_type: string; scope: string;
}

export function buildGoogleAuthUrl(args: { clientId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: args.clientId, redirect_uri: args.redirectUri, response_type: "code",
    scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent", state: args.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

type Fetch = typeof fetch;
async function tokenRequest(body: URLSearchParams, fetchImpl: Fetch): Promise<GoogleTokens> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new GoogleAuthError(`google token endpoint ${res.status}: ${json.error}`, String(json.error ?? "token_error"), res.status);
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
    expiry_date: Date.now() + Number(json.expires_in ?? 0) * 1000,
    token_type: String(json.token_type ?? "Bearer"), scope: String(json.scope ?? ""),
  };
}

export async function exchangeCode(args: { code: string; clientId: string; clientSecret: string; redirectUri: string; fetchImpl?: Fetch }) {
  return tokenRequest(new URLSearchParams({
    grant_type: "authorization_code", code: args.code, client_id: args.clientId,
    client_secret: args.clientSecret, redirect_uri: args.redirectUri,
  }), args.fetchImpl ?? fetch);
}

export async function refreshAccessToken(args: { refreshToken: string; clientId: string; clientSecret: string; fetchImpl?: Fetch }) {
  return tokenRequest(new URLSearchParams({
    grant_type: "refresh_token", refresh_token: args.refreshToken,
    client_id: args.clientId, client_secret: args.clientSecret,
  }), args.fetchImpl ?? fetch);
}
```

- [ ] **Step 3: implement `tokens.ts`** — `getValidAccessToken(db, account, deps?)`: unseal → if `expiry_date - now > 60_000` return; else refresh, merge (`refresh_token` kept from old if absent in response), re-seal, `db.update(googleAccounts)` set encryptedTokens/updatedAt; on `GoogleAuthError code invalid_grant` → update `status='reauth_required'`, throw `ReauthRequiredError(account.id, account.email)`. `deps = { fetchImpl?, sealKey?, clientId?, clientSecret? }` (env defaults `GOOGLE_CLIENT_ID/SECRET`).
- [ ] **Step 4: implement `accounts.ts`** — `upsertGoogleAccount(db, {ownerId, email, tokens, sealKey?})` (onConflictDoUpdate on `(ownerId,email)`: tokens, `status:'active'`, scopes, updatedAt — cursors untouched so re-consent does NOT re-backfill); `listActiveGoogleAccounts(db, ownerId)`; `getGoogleAccount(db, ownerId, accountId)`; `deleteGoogleAccount(db, ownerId, accountId)`; `appendUserAction(db, {ownerId, action, entityType?, entityId?, payload?})` lives here? No — **create `packages/core/src/activity/user-actions.ts`** with `appendUserAction` (insert-only) and export it; connect/disconnect/dispositions all use it.
- [ ] **Step 5: run tests, commit** `feat(MC-101): google oauth + token refresh + reauth flagging`

### Task 3: Web OAuth routes + settings UI — MC-101

**Files:**
- Create: `apps/web/app/api/google/connect/route.ts`, `apps/web/app/api/google/callback/route.ts`, `apps/web/app/api/google/disconnect/route.ts`, `apps/web/src/queues.ts`, `apps/web/app/settings/google-settings.tsx` (server-rendered list + forms)
- Modify: `apps/web/app/settings/page.tsx`, `apps/web/src/session.ts` (add `oauthState?: string` to SessionData), `apps/web/src/queries.ts` (google account list w/ ownerId), `apps/web/package.json` (`bullmq`, `ioredis`), `.env.example` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)
- Test: `apps/web/src/google-routes.test.ts` (route-guard: unauthenticated → 401/redirect)

Behavior:
- `GET /api/google/connect`: requireOwnerId; `state = crypto.randomUUID()` saved in session; redirect to `buildGoogleAuthUrl` (redirectUri = `${NEXT_PUBLIC_APP_URL}/api/google/callback`). Missing `GOOGLE_CLIENT_ID` → 500 with plain message.
- `GET /api/google/callback`: verify `state` matches session (clear it); `exchangeCode`; fetch `https://gmail.googleapis.com/gmail/v1/users/me/profile` with the access token → `emailAddress`; `upsertGoogleAccount`; `appendUserAction(action:'google_connected', entityType:'google_account', entityId, payload:{email})`; enqueue initial syncs on `ingest` queue: jobs `ingest_gmail`/`ingest_gcal` `{accountId}` with jobIds `ingest-gmail-<accountId>-initial` / `ingest-gcal-<accountId>-initial`; redirect `/settings?connected=<email>`.
- `POST /api/google/disconnect` `{accountId}`: delete row, `appendUserAction('google_disconnected')`, redirect `/settings`.
- `apps/web/src/queues.ts`: lazy singleton `getQueue(name: "ingest"|"extraction")` — `new Queue(name, { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) })`, same defaultJobOptions as worker.
- Settings page: connected accounts with status; `status==='reauth_required'` renders a red banner + "Reconnect" link to `/api/google/connect`; connect button otherwise.

- [ ] Steps: failing route-guard test → implement → manual check `npm run dev` renders settings → commit `feat(MC-101): OAuth connect/callback/disconnect + settings surface`

### Task 4: Gmail client + sync service — MC-102

**Files:**
- Create: `packages/core/src/ingest/gmail-client.ts`, `packages/core/src/ingest/gmail.ts`, `packages/core/src/ingest/people.ts`, `packages/core/src/ingest/index.ts`
- Test: `packages/core/src/ingest/gmail.test.ts`, `packages/core/src/ingest/people.test.ts`
- Fixtures: `packages/core/src/ingest/__fixtures__/gmail/*.json` (recorded-shape API responses, synthetic content)

`gmail-client.ts` — fetch-based, injectable:

```ts
export interface GmailMessage {
  id: string; threadId: string; internalDate: number;
  from: string; to: string; subject: string; snippet: string; bodyExcerpt: string;
}
export interface GmailHistoryPage { historyId: string; messageIds: string[]; nextPageToken?: string }
export class GmailHistoryGoneError extends Error {}
export interface GmailClient {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listHistory(startHistoryId: string, pageToken?: string): Promise<GmailHistoryPage>; // 404 → GmailHistoryGoneError
  listMessageIds(q: string, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }>;
  getMessage(id: string): Promise<GmailMessage>;
}
export function createGmailClient(getAccessToken: () => Promise<string>, fetchImpl = fetch): GmailClient
```

Parsing: headers From/To/Subject from `payload.headers`; `bodyExcerpt` = first `text/plain` part (walk parts recursively), base64url-decoded, trimmed to 2000 chars; fall back to `snippet`.

`people.ts`:

```ts
export function parseAddress(header: string): { email: string; name?: string } // "Dana R <dana@x.com>" forms
export async function resolvePerson(db, ownerId, { email, name }, occurredAt): Promise<string> // person id
// match: lower(email) = any(emails); on miss insert {displayName: name ?? localpart, emails: [email]};
// always bump last_contact_at = greatest(existing, occurredAt) and updated_at; backfill displayName if row has bare localpart and a real name arrives.
```

`gmail.ts` — the sync algorithm:

```ts
export interface GmailSyncDeps { client: GmailClient; now?: Date }
export interface GmailSyncResult {
  mode: "initial_backfill" | "incremental" | "cursor_fallback";
  newEpisodeIds: string[];          // ALL new episode ids
  extractEpisodeIds: string[];      // subset to enqueue extraction for ([] on initial_backfill)
  quotaUnits: number; messagesSeen: number;
}
export async function syncGmail(db, ownerId: string, accountId: string, deps: GmailSyncDeps): Promise<GmailSyncResult>
```

- No cursor → **initial_backfill**: `listMessageIds("after:" + unixSeconds(now − 30d))` paged; skip ids already present (batch query `episodes.rawRef in (...)` for `source='gmail'`); `getMessage` each; insert episodes (`type:'email_received'`, `source:'gmail'`, `rawRef: msg.id`, `occurredAt: new Date(internalDate)`, `summary: subject`, `payload: {from,to,subject,snippet,bodyExcerpt}`, `relatedPersonIds:[senderPersonId]`) with `onConflictDoNothing` + returning; resolve sender person; `extractEpisodeIds = []`; set `gmailHistoryId` from `getProfile()`, `gmailLastSyncAt = now`.
- Cursor → **incremental**: `listHistory(cursor)` paged, dedupe message ids; fetch + upsert as above; `extractEpisodeIds = newEpisodeIds`; advance cursor to returned `historyId`, set `gmailLastSyncAt`.
- `GmailHistoryGoneError` → **cursor_fallback**: re-list with `after:` = `gmailLastSyncAt − 1h` (overlap; upsert converges), `extractEpisodeIds = newEpisodeIds`, reset cursor from profile.
- `quotaUnits`: 5/`messages.get` + 5/`messages.list` + 2/`history.list` call.

- [ ] **Step 1: failing tests** with a `FakeGmailClient` built from fixtures: happy incremental (2 new msgs → 2 episodes, 2 extract ids, cursor advanced); empty delta (no rows, cursor advanced); replay same window (zero new rows, zero extract ids); 404 fallback (cursor reset, extraction enqueued for new); initial backfill (episodes + people written, `extractEpisodeIds` empty, cursor set); person create-vs-match (two emails from same address → one person, `last_contact_at` = later date).
- [ ] **Step 2: implement** as above. **Step 3: green. Step 4: commit** `feat(MC-102): gmail history sync + person resolution in core`

### Task 5: Worker ingest processor + scheduler — MC-102

**Files:**
- Create: `apps/worker/src/jobs/ingest.ts`
- Modify: `apps/worker/src/jobs/index.ts` (case "ingest"), `apps/worker/src/schedulers.ts` (ingest tick), `.env.example` (nothing new)
- Test: `apps/worker/src/jobs/ingest.test.ts`

Behavior:
- Scheduler: `queues.ingest.upsertJobScheduler("ingest-tick", { pattern: "*/15 * * * *", tz: SCHEDULE_TZ }, { name: "ingest_tick" })`.
- `ingest_tick`: read working hours from `user_preferences` key `working_hours` (default `{ startHour: 7, endHour: 19 }`); outside window → return `{ skipped: "outside_working_hours" }` WITHOUT opening a run (a skip is not a failure; avoids 96 noise rows/day — note in plan rationale). Inside: for each active google account enqueue `ingest_gmail` + `ingest_gcal` `{accountId}` with jobId `ingest-gmail-<accountId>-<stamp>` where `stamp = YYYY-MM-DDTHH-mm` Denver floored to 15 min, `:`→`-`. Wrap the tick itself in `withCadenceRun` (jobName `ingest_tick`).
- `ingest_gmail`: `withCadenceRun(jobName:'ingest_gmail')`; build client via `createGmailClient(() => getValidAccessToken(db, account))`; `syncGmail`; `appendRunStep` seq 1 `sync` detail `{mode, messagesSeen, newEpisodes, quotaUnits}`; enqueue `extraction` jobs (`name:'extract_commitments'`, `{episodeId}`, jobId `extract-episode-<episodeId>`) — step seq 2 `enqueue_extraction` with count. Catch `ReauthRequiredError`: send push alert via `sendPushToOwner` (title "Google re-connect needed", url `/settings`) inside a try/catch step, then rethrow so the run fails with error `reauth_required: <email>` (BullMQ will retry but the account status check at job start fails fast: if `account.status === 'reauth_required'` throw immediately with same message — no Google calls, no crash-loop).
- Tests: tick window gating (fake now); reauth fast-fail writes failed run; extraction enqueue count matches new episodes (use a fake queue / inspect `queues.extraction.add` via a stub object).

- [ ] failing tests → implement → green → commit `feat(MC-102): ingest queue processor + 15-min scheduler with reauth fast-fail`

### Task 6: GCal client + sync + worker wiring — MC-103

**Files:**
- Create: `packages/core/src/ingest/gcal-client.ts`, `packages/core/src/ingest/gcal.ts`
- Test: `packages/core/src/ingest/gcal.test.ts`
- Fixtures: `packages/core/src/ingest/__fixtures__/gcal/*.json`
- Modify: `apps/worker/src/jobs/ingest.ts` (case `ingest_gcal`)

`gcal-client.ts`:

```ts
export interface GcalEvent {
  id: string; status: string; updated: string; summary?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  attendees?: { email: string; displayName?: string; self?: boolean }[]; raw: unknown;
}
export class GcalSyncTokenExpiredError extends Error {}
export interface GcalClient {
  listEvents(args: { syncToken?: string; timeMin?: string; pageToken?: string }):
    Promise<{ items: GcalEvent[]; nextPageToken?: string; nextSyncToken?: string }>; // 410 → GcalSyncTokenExpiredError
}
```
(`singleEvents=true` always; primary calendar.)

`gcal.ts` — `syncGcal(db, ownerId, accountId, deps)`:
- No `gcalSyncToken` → initial: `timeMin = now − 30d`; **backfill flag true**.
- Token → incremental with `syncToken`; `GcalSyncTokenExpiredError` → full resync from `timeMin = now − 30d` (upserts converge).
- Per event: `status==='cancelled'` → if `calendar_events` row exists update `status:'cancelled'`, `updatedAt`; else skip (no insert — cancelled deltas lack start). Otherwise upsert on `(ownerId, gcalEventId)` (title, startsAt from `dateTime ?? date`, endsAt, attendees JSON with resolved `personId` per attendee email (skip `self`), status confirmed, raw, updatedAt). New or changed (`updated` differs) → insert episode `{type:'event_synced', source:'gcal', rawRef: `${id}@${updated}`, occurredAt: now, summary: title, payload: {gcalEventId, action: created|updated|cancelled}}` onConflictDoNothing — replay converges.
- **No extraction enqueued for gcal episodes in Phase 1** (MC-103 omits it deliberately; calendar chatter is the R3 noise source — record in INSIGHTS if this proves wrong). Result mirrors `GmailSyncResult` minus extraction ids; store `gcalSyncToken`/`gcalLastSyncAt`.
- Worker `ingest_gcal`: same bracketing/reauth pattern as gmail.

- [ ] failing tests (initial sync writes events+episodes+people; move event → update + second episode; cancel → status flip; token expiry → full resync converges, zero dup rows) → implement → green → commit `feat(MC-103): gcal incremental sync into calendar_events + episodes`

**Session 1.1 close:** `npm run typecheck && npm run lint && npm test` green; forced failure visible on `/runs` (run `ingest_gmail` with bogus tokens locally once).

---

## Session 1.2 — Extraction + LLM layer (MC-104, MC-107)

### Task 7: `packages/llm` `complete()` — MC-104

**Files:**
- Create: `packages/llm/src/config.ts`, `packages/llm/src/types.ts`, `packages/llm/src/anthropic.ts`, `packages/llm/src/complete.ts`
- Modify: `packages/llm/src/index.ts` (exports), `packages/llm/package.json` (deps: `@anthropic-ai/sdk`, `zod`, `@mission-control/db`)
- Test: `packages/llm/src/complete.test.ts`, `packages/llm/src/config.test.ts`

`config.ts`:

```ts
export type Tier = "cheap" | "mid" | "top" | "embed";
export const TIER_MODELS: Record<Exclude<Tier, "embed">, { provider: "anthropic"; model: string }> = {
  cheap: { provider: "anthropic", model: "claude-haiku-4-5" },
  mid:   { provider: "anthropic", model: "claude-sonnet-4-6" },   // reserved: cos.chat (Phase 4)
  top:   { provider: "anthropic", model: "claude-opus-4-8" },
};
// USD per MTok (ARCHITECTURE §2.7); cache-read at 0.1× input per Anthropic pricing.
export const MODEL_PRICES: Record<string, { inPerMTok: number; outPerMTok: number; cacheReadPerMTok: number }> = {
  "claude-haiku-4-5":  { inPerMTok: 1, outPerMTok: 5,  cacheReadPerMTok: 0.1 },
  "claude-sonnet-4-6": { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3 },
  "claude-opus-4-8":   { inPerMTok: 5, outPerMTok: 25, cacheReadPerMTok: 0.5 },
};
export const TASK_TIERS: Record<string, Tier> = {
  "cos.extract_commitments": "cheap",
  "eval.match_judge": "cheap",
};
export function resolveTask(task: string) { /* tier = TASK_TIERS[task] ?? throw; return { tier, ...TIER_MODELS[tier] } */ }
export function computeCostUsd(model: string, usage: {inputTokens:number; outputTokens:number; cacheReadTokens:number}): string // numeric(10,6) string, 6dp
```

`types.ts` — adapter seam:

```ts
export interface StructuredCallArgs {
  model: string; system?: string; prompt: string;
  toolName: string; toolDescription: string; jsonSchema: Record<string, unknown>; maxTokens: number;
}
export interface StructuredCallResult {
  toolInput: unknown;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}
export interface ProviderAdapter { completeStructured(args: StructuredCallArgs): Promise<StructuredCallResult>; }
```

`anthropic.ts` — the ONLY provider-SDK import in the repo: lazy `new Anthropic()` (env `ANTHROPIC_API_KEY`); `messages.create` with `tools: [{ name, description, input_schema: jsonSchema, strict: true }]` (cast if SDK types lag), `tool_choice: { type: "tool", name }`; find the `tool_use` block (missing → throw); usage from `response.usage` (`cache_read_input_tokens ?? 0`).

`complete.ts`:

```ts
export class LlmSchemaError extends Error {}
export interface CompleteArgs<T> {
  db: Db; ownerId: string; task: string;
  schema: z.ZodType<T>; system?: string; prompt: string;
  toolName?: string; toolDescription?: string; maxTokens?: number;
  runId?: string | null; promptVersion?: string; dataCategories: string[];
  agentKey?: string; adapter?: ProviderAdapter; // injectable for tests
}
export interface CompleteResult<T> { data: T; modelCallId: string; costUsd: string; latencyMs: number }
export async function complete<T>(args: CompleteArgs<T>): Promise<CompleteResult<T>>
```

Flow: resolve task → `z.toJSONSchema(schema)` → attempt 1 → `schema.safeParse(toolInput)`; on fail, attempt 2 with prompt + `\n\nYour previous output failed schema validation:\n<zod issues JSON>\nReturn corrected output via the tool.`; statuses `ok` / `schema_retry_ok` / `failed`. ALWAYS insert exactly one `model_calls` row (summed usage across attempts, cost via `computeCostUsd`, latency wall-clock, error text on failure) — then return or throw `LlmSchemaError`. Provider (network) errors: write `failed` row, rethrow original. The model_calls insert is direct here (llm owns this table per invariant 3).

Tests (mock adapter, real DB): happy path row fields (tier cheap, provider anthropic, tokens, cost arithmetic exact e.g. 1000 in/500 out haiku → `0.003500`); malformed→valid retry → `schema_retry_ok` + summed tokens; malformed→malformed → throws `LlmSchemaError` + `failed` row; unknown task throws without a row; cost arithmetic unit tests in `config.test.ts`.

- [ ] failing tests → implement → green → commit `feat(MC-104): packages/llm complete() — tier routing, forced tool-use, schema retry, cost-tracked model_calls`

### Task 8: Lint rule hardening + planted-import test — MC-104

**Files:**
- Modify: `eslint.config.mjs` (add `@anthropic-ai/*`, `openai`, `@google/generative-ai`, `voyageai` to restricted paths via `patterns`)
- Test: `packages/llm/src/lint-rule.test.ts` — programmatic `ESLint` (root config) on `lintText('import Anthropic from "@anthropic-ai/sdk"', { filePath: "<repo>/apps/web/planted.ts" })` → expect 1 error; same text at `packages/llm/src/x.ts` → 0 errors. Add `eslint` + `@eslint/js` etc. resolution via root (devDep `eslint` in llm workspace).
- [ ] failing test → config change → green → commit `feat(MC-104): provider-SDK import ban enforced + tested`

### Task 9: Extraction prompt v1 + service — MC-104

**Files:**
- Create: `packages/core/src/extraction/extract_commitments.v1.ts`, `packages/core/src/extraction/active.ts`, `packages/core/src/extraction/service.ts`, `packages/core/src/extraction/index.ts`
- Test: `packages/core/src/extraction/service.test.ts`, `packages/core/src/extraction/prompt.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json` (deps: `zod`, `@mission-control/llm`)

`extract_commitments.v1.ts` (prompt + schema together, versioned module):

```ts
import { z } from "zod";
import { createHash } from "node:crypto";

export const ExtractedCommitment = z.object({
  direction: z.enum(["owed_by_me", "owed_to_me"]),
  counterparty_name: z.string().nullable(),
  counterparty_email: z.string().nullable(),
  description: z.string().min(1),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  due_date_basis: z.enum(["explicit", "inferred"]).nullable(),
  confidence: z.number().min(0).max(1),
  source_excerpt: z.string().min(1),
});
export const ExtractionOutput = z.object({ commitments: z.array(ExtractedCommitment) });
export type ExtractionOutputT = z.infer<typeof ExtractionOutput>;

export interface ExtractionInput {
  sourceType: "email" | "chat" | "calendar" | "manual";
  ownerName: string; ownerEmails: string[];
  from?: string; to?: string; subject?: string;
  occurredAt: string; // ISO, with weekday rendered in the prompt
  body: string;
}

const SYSTEM = `You extract concrete commitments from one piece of source content belonging to ${"the owner"} ... [full prompt text — see Prompt v1 spec below]`;

export const extractCommitmentsV1 = {
  task: "cos.extract_commitments" as const,
  version: "v1" as const,
  schema: ExtractionOutput,
  system: SYSTEM,
  renderPrompt(input: ExtractionInput): string { /* labeled blocks: SOURCE TYPE / FROM / TO / SUBJECT / OCCURRED AT (incl. weekday) / OWNER (name + emails) / BODY */ },
  contentHash(): string {
    return createHash("sha256").update(SYSTEM).update(JSON.stringify(z.toJSONSchema(ExtractionOutput))).digest("hex");
  },
};
```

**Prompt v1 spec (write in full in the module):** definition of a commitment (specific, actionable obligation one party owes another, stated or clearly accepted); direction rules relative to the OWNER (the owner promising = `owed_by_me`; someone promising the owner = `owed_to_me`; owner's own emails appear in FROM too — first person in owner's sent mail = owed_by_me); exclusions (aspirational "we should grab coffee", newsletters/marketing/automated mail, FYI status updates, pure scheduling chatter, past-tense completed work, vague intentions without a deliverable); due-date resolution relative to OCCURRED AT with weekday arithmetic, `basis: "explicit"` for stated dates/days, `"inferred"` for "before the meeting"-style deductions, null when none; `source_excerpt` = shortest verbatim quote containing the commitment; `confidence` calibration (≥0.9 explicit promise; ~0.7 strongly implied; ≤0.5 ambiguous — extract sparingly, precision over recall: an empty list is correct for most messages); output via tool only.

`active.ts`: `export const ACTIVE_EXTRACTION = extractCommitmentsV1;` (the single config place).

`service.ts`:

```ts
export function extractionHash(sourceRef: string, description: string): string // sha256(`${sourceRef}|${normalize(description)}`)
export function normalizeDescription(s: string): string // lowercase, strip non-alphanum→space, collapse
export async function extractCommitmentsFromEpisode(db, args: {
  ownerId: string; episodeId: string; runId?: string; force?: boolean;
  completeImpl?: typeof complete; promptModule?: typeof ACTIVE_EXTRACTION;
}): Promise<{ status: "skipped_existing" | "done"; created: number; durable: number }>
```

- Load episode (owner-scoped); **episode guard**: `force !== true` and any commitment with `sourceEpisodeId === episodeId` exists → return `skipped_existing` (no model call — episodes are immutable, re-extraction is never new information).
- ownerName/ownerEmails: users row + `google_accounts.email` list.
- Input from payload (`email_received` → from/to/subject/bodyExcerpt; `chat_message` → body = payload.text).
- `complete({ task, schema, system, prompt, runId, promptVersion: 'v1', dataCategories: episode.source === 'gmail' ? ['email'] : ['capture'] })`.
- Per candidate: counterparty resolution — email present → `resolvePerson`; name only → find person by exact `displayName` (case-insensitive, owner-scoped) else create with empty emails; both null → null. `sourceRefForHash = episode.rawRef ?? episode.id`. Insert commitment `{ direction, counterpartyPersonId, description, sourceType: map(episode.source), sourceEpisodeId, sourceRef: episode.rawRef, sourceExcerpt, dueDate, dueDateBasis, status:'candidate', confidence, extractionHash, promptVersion:'v1' }` with `onConflictDoNothing` on the hash index → `created` counts inserts.

Tests (mock `completeImpl`): candidate written with all fields + person created; **hash idempotency** (run twice → 1 row); **episode guard** (seed one commitment for episode, then run with a v2-style differently-worded mock → no new row, zero model calls — assert mock not called); chat episode path; sourceType mapping; normalize/hash unit cases. `prompt.test.ts`: renderPrompt includes weekday + owner emails; contentHash stable across calls.

- [ ] failing tests → implement → green → commit `feat(MC-104): extraction prompt v1 + candidate writes with extraction_hash idempotency`

### Task 10: Worker extraction processor + prompt_versions record — MC-104

**Files:**
- Create: `apps/worker/src/jobs/extraction.ts`, `packages/core/src/extraction/prompt-versions.ts` (`recordPromptVersion(db)` — upsert `(agentKey, task, version)` with `contentHash`, no eval fields; called idempotently at worker startup so the active version is always registered)
- Modify: `apps/worker/src/jobs/index.ts`, `apps/worker/src/index.ts` (call `recordPromptVersion(db)` after `resolveOwner`)
- Test: `apps/worker/src/jobs/extraction.test.ts` (integration: seeded chat episode + mocked adapter via env? No — inject `completeImpl` through a module-level test seam is awkward in the processor; instead test the processor with a stubbed `ctx` and `vi.mock` of `@mission-control/core`'s `extractCommitmentsFromEpisode`? Simpler and honest: processor test asserts bracketing + arg passing with a real DB and a mock `extractCommitmentsFromEpisode` injected via processor deps param `makeExtractionProcessor(ctx, deps?)` mirroring `makeNotifyProcessor`'s `NotifyDeps` pattern.)

Processor: job name `extract_commitments`, `{episodeId}`; `withCadenceRun(jobName:'extract_commitments', jobId: job.id ?? 'extract-episode-' + episodeId)`; call service; return result (lands in run row via close).

- [ ] failing test → implement → green → run the **real loop locally once** (docker up, `ANTHROPIC_API_KEY` set): insert a chat episode via SQL or capture (Task 14 not yet — use a small `tsx` one-off through service), verify `commitments` candidate + `model_calls` cheap-tier row with cost. **Step: verify failure path** — run with bogus API key → failed run visible on `/runs`.
- [ ] commit `feat(MC-104): extraction queue processor + prompt_versions registration`

### Task 11: Run-health page upgrade — MC-107

**Files:**
- Create: `apps/web/app/runs/[id]/page.tsx` (step drill-down: run row, meta JSON, steps table w/ status/detail), `apps/web/app/api/runs/[id]/retry/route.ts`, `apps/web/app/nav-badge.tsx`
- Modify: `apps/web/app/runs/page.tsx` (latest-per-job section on top, red failures, retry button per failed latest, link to drill-down), `apps/web/src/queries.ts` (`latestRunPerJob` via `db.selectDistinctOn([cadenceRuns.jobName])…orderBy(jobName, desc(startedAt))`, `getRun`, `listRunSteps`), `apps/web/app/layout.tsx` (nav with badge)
- Test: `apps/web/src/runs.test.ts` (latest-per-job query shape against seeded rows: 2 jobs × 2 runs → 2 rows, newest each; badge predicate; retry route guard 401)

Retry recipes (route handler, owner-checked, by `run.jobName`):

| jobName | enqueue |
|---|---|
| `ingest_gmail` / `ingest_gcal` | same `{accountId}` from run meta (store `accountId` in run meta in Task 5 — add it), jobId `<orig>-r<epochSec>` |
| `extract_commitments` | `{episodeId}` from meta (store it), jobId `extract-episode-<id>-r<epochSec>` |
| `morning_brief` | `{date}` parsed from jobId, jobId `morning-brief-<date>-r<epochSec>` |
| `notify` | `{briefId}` from meta/jobId, jobId `notify-<briefId>-r<epochSec>` |

(Idempotency on retry comes from upserts/dedupe keys, not jobIds — note on the route.) Unknown jobName → 400 with message. Modify Task 5/10 handlers to include the needed meta on `openCadenceRun` (`meta: {accountId}` / `{episodeId}`).

- [ ] failing tests → implement → green → force one failure locally, see red + retry it in-app → commit `feat(MC-107): run-health latest-per-job, step drill-down, in-app retry, nav badge`

**Session 1.2 close:** full `typecheck/lint/test`; INSIGHTS.md entry if prompt behavior taught anything.

---

## Session 1.3 — Confirmation queue + eval harness + capture (MC-105, MC-106, MC-108)

### Task 12: Disposition services — MC-105

**Files:**
- Create: `packages/core/src/commitments/dispositions.ts`, `packages/core/src/commitments/queries.ts`, `packages/core/src/commitments/index.ts`
- Test: `packages/core/src/commitments/dispositions.test.ts`
- Modify: `packages/core/src/index.ts`

```ts
// dispositions.ts — invariant 5: only these functions advance commitment state,
// and every one writes user_actions (+ extraction_labels when a candidate is dispositioned).
confirmCommitment(db, { ownerId, commitmentId }): status candidate→open guard (WHERE status='candidate'), confirmedAt=now;
  user_actions 'commitment_confirmed'; extraction_labels { label:'confirmed', promptVersion: row.promptVersion ?? 'manual', sourceEpisodeId }
rejectCommitment(db, { ownerId, commitmentId }): candidate→dropped, resolvedAt=now; action 'commitment_rejected'; label 'rejected'
editAndConfirmCommitment(db, { ownerId, commitmentId, edits: { description?, direction?, dueDate?, dueDateBasis?, counterpartyPersonId? } }):
  diff = { field: { from, to } } for changed fields only; apply edits + candidate→open + confirmedAt;
  action 'commitment_edited' payload diff; label 'edited' editedFields diff
snoozeCommitment(db, { ownerId, commitmentId, until: Date }): set snoozedUntil only (status untouched — snooze is a predicate);
  action 'commitment_snoozed' payload {until}; NO label
addManualCommitment(db, { ownerId, direction, description, counterpartyPersonId?, dueDate?, sourceType:'manual' }):
  insert status 'open', confirmedAt now (skips candidate state); action 'commitment_added'; NO label
// queries.ts
listCandidates(db, ownerId): status='candidate' AND (snoozed_until is null or <= now()), newest first, joined person displayName
listOpenCommitments(db, ownerId, view: 'open'|'owed_to_me'|'snoozed') // snoozed = snoozed_until > now(), any non-terminal status
```

Tests: each disposition's state+timestamp transition; label payloads (incl. edited diff shape); confirm on already-open row is a no-op (guard); snooze leaves status; manual add skips candidate; all queries owner-scoped (second owner sees nothing).

- [ ] failing tests → implement → green → commit `feat(MC-105): disposition services — the only commitment state-advancers`

### Task 13: Queue + ledger UI — MC-105

**Files:**
- Create: `apps/web/app/queue/page.tsx`, `apps/web/app/queue/candidate-card.tsx` (client), `apps/web/app/commitments/page.tsx`, `apps/web/app/commitments/add-form.tsx`, `apps/web/app/api/commitments/route.ts` (POST manual add), `apps/web/app/api/commitments/[id]/confirm/route.ts`, `.../reject/route.ts`, `.../edit/route.ts`, `.../snooze/route.ts`
- Modify: `apps/web/app/layout.tsx` (nav links: Queue, Commitments, Capture placeholder), `apps/web/src/queries.ts` (re-export core commitment queries usage)
- Test: `apps/web/src/commitment-routes.test.ts` (all five routes 401 unauthenticated — ownerless access impossible)

UI (function over form, two taps max on phone): candidate card = description, direction chip, person, confidence (2dp), due date, `<details>` source excerpt; buttons Confirm / Reject / Snooze-1w / Edit (`<details>` inline form: description, direction select, due date, then "Confirm edited"). Buttons are a small client component doing `fetch(POST)` + `router.refresh()`. `/commitments`: three views via `?view=` (open default / owed_to_me / snoozed), manual add form (description, direction, due date, counterparty name → resolve-or-create person via core `resolvePerson` with no email → API does it).

- [ ] route-guard tests → implement → manual phone-width check via dev server → commit `feat(MC-105): confirmation queue + ledger UI with one-tap dispositions`

### Task 14: Quick-capture chat — MC-108

**Files:**
- Create: `apps/web/app/capture/page.tsx` (shell), `apps/web/app/capture/capture-chat.tsx` (client: message list + inline candidates, 4s polling, send box), `apps/web/app/api/capture/route.ts` (POST), `apps/web/app/api/capture/feed/route.ts` (GET)
- Test: `apps/web/src/capture.test.ts`
- Modify: `apps/web/app/layout.tsx` nav

Behavior:
- POST `{text}` (validate non-empty ≤4000): insert episode `{source:'chat', type:'chat_message', occurredAt: now, summary: text.slice(0,140), payload:{text}}`; `appendUserAction('capture_submitted', entityType:'episode', entityId)`; enqueue extraction (`getQueue("extraction").add('extract_commitments', {episodeId}, {jobId: 'extract-episode-'+episodeId})`); return `{episodeId}`.
- GET feed: last 50 chat episodes (owner-scoped, asc) + all commitments with `sourceEpisodeId` in that set (any status — confirmed ones render with their state so dispositions stick visually). Shape `{messages:[{id,text,occurredAt}], candidates:[{id, episodeId, description, direction, status, confidence, personName, dueDate}]}`.
- Client: renders thread; candidate cards inline under their message using the SAME endpoints as MC-105 (confirm/reject) then refetch. Poll feed every 4s while visible.
- Tests: POST writes episode + user_action and enqueues (stub queue via DI seam `apps/web/src/queues.ts` export `setQueueForTesting`? simpler: the route imports `enqueueExtraction(episodeId)` from `src/queues.ts`; test the queue module with an injected fake; route test covers 401 + episode/user_action writes with redis running locally/CI — redis IS available in CI). Feed route 401; feed shape on seeded data.

- [ ] failing tests → implement → green → manual: type "told Sara I'd send the contract Friday" with worker running → candidate appears inline (requires API key; if absent verify the failed extraction run is red on /runs instead) → commit `feat(MC-108): quick-capture chat — message → episode → extraction, candidates inline`

### Task 15: Eval harness — fixtures + matcher + runner — MC-106

**Files:**
- Create: `evals/src/fixtures.ts` (load/validate), `evals/src/match.ts`, `evals/src/judge.ts`, `evals/src/metrics.ts`, `evals/src/runner.ts`, rewrite `evals/src/run.ts` (CLI), `evals/src/anonymize.ts` (CLI `eval:anonymize`), `evals/fixtures/extraction/fx-001…fx-02N.json` (≥25), `evals/.judge-cache.json` (committed, starts `{}`)
- Modify: `evals/package.json` (deps `@mission-control/{core,llm,db}`, `zod`; scripts `eval`, `eval:anonymize`), root `package.json` (`eval:anonymize` passthrough), `.gitignore` (`evals/fixtures/_staging/`)
- Test: `evals/src/match.test.ts`, `evals/src/fixtures.test.ts`, `evals/src/guard.test.ts`

Fixture shape: exactly EVAL-SPEC §1.1 (plus optional `"aliases": Record<email, string[]>`). **Authoring note:** v1 fixtures are synthetic-but-realistic (real-mail promotion begins with production rejections per §1.3 — INSIGHTS entry). Mix: ≥9 hard negatives (`expected: []`): newsletter, marketing, automated receipt, FYI thread, "we should grab coffee", scheduling chatter, past-tense report, vague "let's sync", calendar invite text; positives covering: explicit due date, weekday resolution ("by Thursday"), inferred due ("before the board meeting"), owed_to_me vs owed_by_me, two commitments one message opposite directions, chat captures ("told Sara I'd send the contract Friday"), no-due-date promise, owner's own sent mail.

`match.ts` (pure, unit-tested) — EVAL-SPEC §2 exactly:

```ts
export interface MatchResult { matches: {expIdx:number; predIdx:number; dueDateOk:boolean; basisSoftMiss:boolean}[]; falsePositives: number[]; falseNegatives: number[]; }
export function contentWords(s: string): string[] // lowercase, alphanum split, drop len<3 + tiny stoplist
export function jaccard(a: string, b: string): number
export async function matchFixture(expected, predicted, opts: { aliases?, judge: (a,b)=>Promise<boolean> }): Promise<MatchResult>
// gate per pair: direction equal AND counterparty (pred email===exp.counterparty, else pred name ∈ aliases[exp.counterparty])
//   AND due (both null | equal dates; basis mismatch → soft miss flag)
//   AND description: j>=0.5 OR (0.2<=j<0.5 AND await judge(pred.description, exp.description_gist))
// greedy one-to-one: sort candidate pairs by jaccard desc, assign best-first
```

`judge.ts`: `makeCachedJudge(db, ownerId)` → cache file keyed `sha256(pred + "|" + gold)`; miss → `complete({task:'eval.match_judge', schema: z.object({same_obligation: z.boolean()}), prompt, dataCategories:['capture']})`; write-through to `evals/.judge-cache.json`.

`runner.ts`:
- `guardDatabaseUrl(url)`: host must be `localhost`/`127.0.0.1` unless `EVAL_ALLOW_REMOTE_DB=1` → else throw "eval runner refuses a non-local DATABASE_URL".
- Ensure eval user (`eval@local.test`) exists (insert onConflictDoNothing).
- Version registry from `packages/core` (`EXTRACTION_VERSIONS: Record<string, module>` exported from `core/extraction/index.ts`; default `--version` = active).
- Per fixture: refuse `anonymized !== true`; build `ExtractionInput` (ownerName "Mark", ownerEmails [`mark@example.com`, fixture.input.to]); `complete()` with the version's system/schema; collect predictions + per-fixture cost/latency from result.
- Aggregate: precision, recall, F1, hard-negative precision (fixtures with `expected:[]`: 1 − (fixtures with ≥1 prediction)/count… define as predictions-on-negatives rate inverted; report `hardNegativeFixtures`, `hardNegativeFalsePositives`), due-date accuracy among matches, basis soft-misses, totals cost/latency.
- Output: console table + write `evals/results/<task>/<version>.json` `{ task, version, promptContentHash, fixtureSetHash, fixtureCount, precision, recall, f1, hardNegative: {...}, dueDateAccuracy, costUsd, meanLatencyMs, generatedAt }` (stable 2-space JSON).
- `--against active`: load active version's committed file, print deltas.
- `--assert-committed` (CI mode): re-run, fail if committed file missing, `promptContentHash` mismatch, or |precision/recall delta| > 2 pts.

Tests: matcher unit matrix (direction mismatch, counterparty alias, due-date null/equal/mismatch, basis soft-miss, jaccard bands incl. judge-band with fake judge, greedy one-to-one on 2×2); fixtures loader rejects `anonymized:false`; guard test (railway URL throws, localhost passes); metrics arithmetic on a tiny fake known set (exact P/R).

`anonymize.ts` (EVAL-SPEC §1.2 workflow, basic): read staging file (same fixture JSON or raw `{from,to,subject,occurred_at,body}`), deterministic substitution from a fake pool seeded by hash(file) (names/emails/orgs consistent within fixture), date shift by per-fixture random offset preserving weekday (offset % 7 === 0), strip signature blocks (`--`-delimited) and quoted history (`>` lines); write to stdout/`--out`, `anonymized: false` left for the human pass.

- [ ] failing tests (matcher/fixtures/guard/metrics) → implement → green → commit `feat(MC-106): eval harness — fixtures, matcher, judge cache, runner`

### Task 16: Baseline run + activation + CI gate — MC-106

**Files:**
- Create: `evals/src/activate.ts` (`npm run eval:activate -w evals`: writes/updates the `prompt_versions` row for the active version FROM the committed results file — sets eval fields + `activatedAt`; refuses if results file missing; EVAL-SPEC §5.3), `.github/workflows/evals.yml`
- Modify: `docs/DEPLOY.md` (new env vars: `TOKEN_SEAL_KEY` now required, `GOOGLE_CLIENT_ID/SECRET`, `ANTHROPIC_API_KEY`; Railway + GH secret `ANTHROPIC_API_KEY` for the eval workflow — Mark's checklist), `.env.example` (`ANTHROPIC_API_KEY=`)

- [ ] **Step 1:** run the baseline for real: `npm run eval -- --task cos.extract_commitments` (local docker DB + real API key). Inspect the table; sanity-check 2–3 mismatches (mediocre numbers are expected and fine — visibility is the criterion).
- [ ] **Step 2:** commit `evals/results/cos.extract_commitments/v1.json` + updated `.judge-cache.json`.
- [ ] **Step 3:** `npm run eval:activate` locally → verify `prompt_versions` row has eval fields + activated_at.
- [ ] **Step 4:** `evals.yml`: on `pull_request` paths `packages/core/extraction/**` + `evals/**` + `workflow_dispatch`; postgres service (like ci.yml); `npm ci`; `npm run eval -- --task cos.extract_commitments --assert-committed` with `ANTHROPIC_API_KEY` from secrets, CI `DATABASE_URL`.
- [ ] commit `feat(MC-106): baseline v1 eval results committed + activation script + CI eval gate`

### Task 17: Phase close-out

- [ ] Full local verification: `npm run typecheck && npm run lint && npm test`; `npm run db:migrate` no-op; drift check (`npm run db:generate` → no diff).
- [ ] **Exit-criteria walkthrough** (local where Google creds absent): (1) capture → inline candidate (live loop) — Google path verified by fixture-driven tests + will be live once Mark sets Railway/Google env per DEPLOY.md; (2) confirm/reject write label rows (SQL spot-check); (3) `npm run eval` prints P/R, results file committed; (4) `model_calls` rows carry cost; (5) baseline visible in `evals/results/` + `prompt_versions`.
- [ ] `docs/INSIGHTS.md`: entries for (at minimum) synthetic-fixture caveat, prompt-v1 precision posture, gcal-no-extraction decision, ingest-tick skip-not-run decision.
- [ ] Update `docs/DEPLOY.md` Phase-1 section: Google Cloud OAuth app setup steps (Testing status, scopes, redirect URI), env var list for Railway, GH secret.
- [ ] Merge `phase-1` → `main` (no-ff merge commit like Phase 0); push.

## Self-review notes

- Spec coverage: MC-101 (Tasks 1–3), MC-102 (4–5), MC-103 (6), MC-104 (7–10), MC-107 (11), MC-105 (12–13), MC-108 (14), MC-106 (15–16). Exit criteria walked in Task 17.
- Deliberate scope decisions: gcal episodes don't enqueue extraction (MC-103 text omits it; R3 noise); ingest tick outside working hours writes no run row (not a failure; avoids noise); fixtures synthetic at v1 (no real mail available to the implementing agent — §1.3 growth path documented); `strict:true` cast if SDK types lag.
- Type consistency: `complete()` returns `{data, modelCallId, costUsd, latencyMs}` — service + runner both use `.data`; `GmailSyncResult.extractEpisodeIds` consumed by Task 5; run meta `{accountId|episodeId}` written in Tasks 5/10, consumed by Task 11 retry.
