# Phase 2 — Morning Brief Implementation Plan (MC-201…MC-204)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The real 7 AM brief: `embed()` + memories (MC-201), ContextPacket assembly (MC-202), Opus-generated morning brief with pre-sync, structured reader, `opened_at`, debug view (MC-203), and delivery hardening — per-channel retry, push health surface, daily cost ticker (MC-204).

**Architecture:** All model calls stay inside `packages/llm` (`complete()` gains a sibling `embed()` with a Voyage fetch adapter — no new SDK). Domain logic lands in `packages/core` (`memories/`, `context/`, new brief prompt module + generator in `briefs/`), the worker wires pre-sync + generation into the existing `briefs` queue, the web app upgrades reader/settings/runs. **No schema migrations needed** — `memories`, `context_packets`, `briefs` all shipped in migration 0000.

**Tech stack:** existing — Drizzle (`cosineDistance` from `drizzle-orm`), Zod v4 (`z.toJSONSchema`), BullMQ, vitest (integration tests hit Postgres at `localhost:5433`), Next.js App Router.

**Branch:** `phase-2-morning-brief` off `main`. One commit per task, `feat(MC-2xx): …` style. Merge `--no-ff` to main at the end (push = Railway deploy).

**Hard constraints (CLAUDE.md invariants):**
- Do NOT modify anything under `packages/core/src/extraction/` — the CI eval gate triggers on that path and the eval CI secret is not yet configured. (Task 7 *reads* `extraction/active.ts` from a new file in `briefs/`; that's fine.)
- `model_calls` rows are written only inside `packages/llm`.
- Activity log append-only; brief lifecycle columns transition once via the `mark*` helpers.
- Every query carries `ownerId`.
- Tests required for everything below; integration tests follow the existing pattern (`createDb(DATABASE_URL ?? localhost:5433)`, seed user in `beforeAll`, clean rows in `beforeEach`, `fileParallelism: false` already configured).

**Pre-existing working-tree changes:** `.env.example`, `apps/web/package.json`, `docs/DEPLOY.md` carry an uncommitted local-dev-port-3100 change (plus an unrelated `.agents/skills/diagnose` template tweak — leave that one unstaged). Task 0 commits the three port files so later edits to `.env.example`/`DEPLOY.md` stay clean.

---

### Task 0: Branch + housekeeping

- [ ] **Step 0.1:** `git checkout -b phase-2-morning-brief`
- [ ] **Step 0.2:** Commit the pre-existing dev-port tweak (NOT the .agents file):

```powershell
git add .env.example apps/web/package.json docs/DEPLOY.md
git commit -m "chore(dev): local web dev on port 3100 (3000 commonly taken)"
```

---

## MC-201 · Embeddings + memories

### Task 1: `packages/llm` — embed-tier config

**Files:**
- Modify: `packages/llm/src/config.ts`
- Test: `packages/llm/src/config.test.ts` (append cases)

- [ ] **Step 1.1: Write failing tests** — append to `config.test.ts`:

```ts
import { computeCostUsd, resolveEmbedTask } from "./config"; // merge into existing imports

describe("resolveEmbedTask", () => {
  it("maps embed.memory and embed.query to voyage-3.5 on the embed tier", () => {
    expect(resolveEmbedTask("embed.memory")).toEqual({
      tier: "embed",
      provider: "voyage",
      model: "voyage-3.5",
    });
    expect(resolveEmbedTask("embed.query").model).toBe("voyage-3.5");
  });

  it("throws on unregistered embed tasks", () => {
    expect(() => resolveEmbedTask("embed.unknown")).toThrow(/register/);
    expect(() => resolveEmbedTask("cos.extract_commitments")).toThrow(/register/);
  });
});

it("prices voyage-3.5 embeddings at $0.06/MTok input", () => {
  expect(computeCostUsd("voyage-3.5", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 })).toBe("0.060000");
  expect(computeCostUsd("voyage-3.5", { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0 })).toBe("0.000060");
});
```

- [ ] **Step 1.2:** Run `npm test -w packages/llm` → new cases FAIL (`resolveEmbedTask` not exported).
- [ ] **Step 1.3: Implement** — in `config.ts`, add `"voyage-3.5": { inPerMTok: 0.06, outPerMTok: 0, cacheReadPerMTok: 0 }` to `MODEL_PRICES`, then append:

```ts
// Embedding tasks resolve separately: the embed tier has its own provider
// (Anthropic ships no embeddings endpoint — SCHEMA.md §0 picked Voyage).
export const EMBED_MODEL = { provider: "voyage" as const, model: "voyage-3.5" };

export const EMBED_TASKS = new Set(["embed.memory", "embed.query"]);

export interface ResolvedEmbedTask {
  tier: "embed";
  provider: "voyage";
  model: string;
}

export function resolveEmbedTask(task: string): ResolvedEmbedTask {
  if (!EMBED_TASKS.has(task))
    throw new Error(`unknown embed task "${task}" — register it in packages/llm config`);
  return { tier: "embed", ...EMBED_MODEL };
}
```

- [ ] **Step 1.4:** `npm test -w packages/llm` → PASS. `npm run typecheck -w packages/llm` → clean.
- [ ] **Step 1.5:** Commit: `feat(MC-201): embed tier config — voyage-3.5 task registry + price table entry`

### Task 2: Voyage adapter + `embed()` writing `model_calls`

**Files:**
- Modify: `packages/llm/src/types.ts` (embedding adapter seam)
- Create: `packages/llm/src/voyage.ts`
- Create: `packages/llm/src/embed.ts`
- Modify: `packages/llm/src/index.ts` (exports; update the "embed() arrives with MC-201" comment)
- Test: `packages/llm/src/voyage.test.ts`, `packages/llm/src/embed.test.ts`

- [ ] **Step 2.1:** Append to `types.ts`:

```ts
// Embedding seam (MC-201): mirrors ProviderAdapter for embed().
export interface EmbedBatchArgs {
  model: string;
  input: string[];
  inputType?: "document" | "query";
}

export interface EmbedBatchResult {
  embeddings: number[][];
  usage: { totalTokens: number };
}

export interface EmbeddingAdapter {
  embedBatch(args: EmbedBatchArgs): Promise<EmbedBatchResult>;
}
```

- [ ] **Step 2.2: Failing adapter test** — `voyage.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createVoyageAdapter } from "./voyage";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("createVoyageAdapter", () => {
  it("posts the batch and returns embeddings ordered by index", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const f = fakeFetch(200, {
      data: [
        { embedding: [0.2], index: 1 },
        { embedding: [0.1], index: 0 },
      ],
      usage: { total_tokens: 7 },
    });
    const adapter = createVoyageAdapter(f);
    const res = await adapter.embedBatch({ model: "voyage-3.5", input: ["a", "b"], inputType: "document" });
    expect(res.embeddings).toEqual([[0.1], [0.2]]);
    expect(res.usage.totalTokens).toBe(7);
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      model: "voyage-3.5",
      input: ["a", "b"],
      input_type: "document",
    });
  });

  it("throws with status + body excerpt on non-2xx", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const adapter = createVoyageAdapter(fakeFetch(429, { detail: "rate limited" }));
    await expect(adapter.embedBatch({ model: "voyage-3.5", input: ["a"] })).rejects.toThrow(/429/);
  });

  it("throws when VOYAGE_API_KEY is missing", async () => {
    delete process.env.VOYAGE_API_KEY;
    const adapter = createVoyageAdapter(fakeFetch(200, { data: [], usage: { total_tokens: 0 } }));
    await expect(adapter.embedBatch({ model: "voyage-3.5", input: ["a"] })).rejects.toThrow(/VOYAGE_API_KEY/);
  });
});
```

- [ ] **Step 2.3:** Run → FAIL. **Implement `voyage.ts`:**

```ts
import type { EmbeddingAdapter } from "./types";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
}

// Fetch-based Voyage client — deliberately no SDK: the embeddings API is one
// endpoint, and packages/llm stays the only provider seam (invariant 3).
export function createVoyageAdapter(fetchImpl: typeof fetch = fetch): EmbeddingAdapter {
  return {
    async embedBatch({ model, input, inputType }) {
      const apiKey = process.env.VOYAGE_API_KEY;
      if (!apiKey) throw new Error("VOYAGE_API_KEY is not set");
      const res = await fetchImpl(VOYAGE_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input, ...(inputType ? { input_type: inputType } : {}) }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`voyage embeddings failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as VoyageResponse;
      const embeddings = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      return { embeddings, usage: { totalTokens: json.usage.total_tokens } };
    },
  };
}
```

- [ ] **Step 2.4: Failing embed() test** — `embed.test.ts` (mirror `complete.test.ts` harness: real DB, seeded user, fake adapter):

```ts
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, modelCalls, users, type Db } from "@mission-control/db";
import { embed } from "./embed";
import type { EmbeddingAdapter } from "./types";

const OWNER_EMAIL = "llm-embed-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control",
  ));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Embed Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  await db.delete(modelCalls).where(eq(modelCalls.ownerId, ownerId));
});

function adapterReturning(embeddings: number[][], totalTokens: number): EmbeddingAdapter {
  return { embedBatch: async () => ({ embeddings, usage: { totalTokens } }) };
}

describe("embed", () => {
  it("returns embeddings and writes a cost-tracked model_calls row", async () => {
    const res = await embed({
      db, ownerId, task: "embed.memory", input: ["prefers async updates"],
      dataCategories: ["memory"], adapter: adapterReturning([[0.1, 0.2]], 1000),
    });
    expect(res.embeddings).toEqual([[0.1, 0.2]]);
    expect(res.model).toBe("voyage-3.5");
    const [row] = await db.select().from(modelCalls).where(eq(modelCalls.id, res.modelCallId));
    expect(row).toMatchObject({
      ownerId, task: "embed.memory", provider: "voyage", model: "voyage-3.5",
      tier: "embed", inputTokens: 1000, outputTokens: 0, status: "ok",
      dataCategories: ["memory"],
    });
    expect(row!.costUsd).toBe("0.000060");
  });

  it("writes a failed row and rethrows on adapter failure", async () => {
    const boom: EmbeddingAdapter = { embedBatch: async () => { throw new Error("voyage down"); } };
    await expect(
      embed({ db, ownerId, task: "embed.query", input: ["q"], dataCategories: ["memory"], adapter: boom }),
    ).rejects.toThrow("voyage down");
    const [row] = await db
      .select().from(modelCalls)
      .where(eq(modelCalls.ownerId, ownerId)).orderBy(desc(modelCalls.createdAt)).limit(1);
    expect(row).toMatchObject({ status: "failed", task: "embed.query", tier: "embed" });
    expect(row!.error).toContain("voyage down");
  });

  it("throws on unknown task before any adapter call or row", async () => {
    await expect(
      embed({ db, ownerId, task: "embed.nope", input: ["x"], dataCategories: [], adapter: adapterReturning([[1]], 1) }),
    ).rejects.toThrow(/register/);
    expect(await db.select().from(modelCalls).where(eq(modelCalls.ownerId, ownerId))).toHaveLength(0);
  });

  it("rejects empty input without a model call", async () => {
    await expect(
      embed({ db, ownerId, task: "embed.memory", input: [], dataCategories: [], adapter: adapterReturning([], 0) }),
    ).rejects.toThrow(/at least one/);
  });
});
```

- [ ] **Step 2.5:** Run → FAIL. **Implement `embed.ts`:**

```ts
import { modelCalls, type Db } from "@mission-control/db";
import { computeCostUsd, resolveEmbedTask } from "./config";
import { createVoyageAdapter } from "./voyage";
import type { EmbeddingAdapter } from "./types";

export interface EmbedArgs {
  db: Db;
  ownerId: string;
  task: string; // "embed.memory" | "embed.query"
  input: string[];
  inputType?: "document" | "query";
  runId?: string | null;
  dataCategories: string[];
  agentKey?: string;
  adapter?: EmbeddingAdapter; // injectable for tests
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  modelCallId: string;
  costUsd: string;
  latencyMs: number;
}

// complete()'s sibling (MC-201): the only embedding entry point, and the only
// other writer of model_calls — same cost-tracking contract (invariant 3).
export async function embed(args: EmbedArgs): Promise<EmbedResult> {
  const { tier, provider, model } = resolveEmbedTask(args.task);
  if (args.input.length === 0) throw new Error("embed requires at least one input string");
  const adapter = args.adapter ?? createVoyageAdapter();

  const started = Date.now();
  let totalTokens = 0;

  async function writeRow(status: "ok" | "failed", error?: string) {
    const [row] = await args.db
      .insert(modelCalls)
      .values({
        ownerId: args.ownerId,
        ...(args.agentKey ? { agentKey: args.agentKey } : {}),
        runId: args.runId ?? null,
        task: args.task,
        provider,
        model,
        tier,
        inputTokens: totalTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: computeCostUsd(model, { inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0 }),
        latencyMs: Date.now() - started,
        dataCategories: args.dataCategories,
        status,
        error,
      })
      .returning({ id: modelCalls.id, costUsd: modelCalls.costUsd });
    if (!row) throw new Error("model_calls insert returned no row");
    return row;
  }

  try {
    const res = await adapter.embedBatch({ model, input: args.input, inputType: args.inputType });
    totalTokens = res.usage.totalTokens;
    const row = await writeRow("ok");
    return {
      embeddings: res.embeddings,
      model,
      modelCallId: row.id,
      costUsd: row.costUsd,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    await writeRow("failed", err instanceof Error ? err.message : String(err));
    throw err;
  }
}
```

- [ ] **Step 2.6:** `index.ts`: add `export * from "./embed";` and `export * from "./voyage";`; reword the header comment (embed() now exists).
- [ ] **Step 2.7:** `npm test -w packages/llm` → PASS; `npm run typecheck -w packages/llm && npm run lint` → clean.
- [ ] **Step 2.8:** Commit: `feat(MC-201): embed() — Voyage adapter, cost-tracked model_calls rows`

### Task 3: `packages/core` memories service

**Files:**
- Create: `packages/core/src/memories/service.ts`, `packages/core/src/memories/index.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./memories";`)
- Test: `packages/core/src/memories/service.test.ts`

- [ ] **Step 3.1: Failing tests** — `service.test.ts`. Helper for seeded vectors: 1024-dim basis vectors so cosine math is exact.

```ts
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, memories, modelCalls, userActions, users, type Db } from "@mission-control/db";
import type { embed } from "@mission-control/llm";
import { createMemory, retrieveMemories } from "./service";

const OWNER_EMAIL = "core-memories-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control",
  ));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Mem Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  await db.delete(memories).where(eq(memories.ownerId, ownerId));
  await db.delete(userActions).where(eq(userActions.ownerId, ownerId));
  await db.delete(modelCalls).where(eq(modelCalls.ownerId, ownerId));
});

// basis vector: 1 at index i, 0 elsewhere (1024 dims = EMBEDDING_DIMS)
function vec(i: number): number[] {
  const v = new Array(1024).fill(0);
  v[i] = 1;
  return v;
}

const fakeEmbed = ((v: number[]) =>
  (async (args: Parameters<typeof embed>[0]) => ({
    embeddings: args.input.map(() => v),
    model: "voyage-3.5",
    modelCallId: "00000000-0000-0000-0000-000000000000",
    costUsd: "0.000001",
    latencyMs: 1,
  }))) as unknown as (v: number[]) => typeof embed;

describe("createMemory", () => {
  it("writes content + embedding + embedding_model and logs memory_pinned for manual pins", async () => {
    const { memoryId } = await createMemory(db, {
      ownerId, content: "Prefers async updates over meetings",
      source: "manual_pin", embedImpl: fakeEmbed(vec(3)),
    });
    const [row] = await db.select().from(memories).where(eq(memories.id, memoryId));
    expect(row).toMatchObject({
      ownerId, content: "Prefers async updates over meetings",
      embeddingModel: "voyage-3.5", source: "manual_pin", pinned: true, status: "active",
    });
    expect(row!.embedding).toHaveLength(1024);
    const [action] = await db
      .select().from(userActions)
      .where(eq(userActions.ownerId, ownerId)).orderBy(desc(userActions.createdAt)).limit(1);
    expect(action).toMatchObject({ action: "memory_pinned", entityType: "memory", entityId: memoryId });
  });

  it("system memories are not pinned and log no user action", async () => {
    await createMemory(db, { ownerId, content: "bg fact", source: "system", embedImpl: fakeEmbed(vec(1)) });
    expect(await db.select().from(userActions).where(eq(userActions.ownerId, ownerId))).toHaveLength(0);
    const [row] = await db.select().from(memories).where(eq(memories.ownerId, ownerId));
    expect(row!.pinned).toBe(false);
  });
});

describe("retrieveMemories", () => {
  async function seed(content: string, embedding: number[] | null, opts: Partial<typeof memories.$inferInsert> = {}) {
    const [row] = await db.insert(memories)
      .values({ ownerId, content, embedding, embeddingModel: "voyage-3.5", source: "system", ...opts })
      .returning({ id: memories.id });
    return row!.id;
  }

  it("ranks by cosine similarity, always includes pinned, filters non-active, touches last_used_at", async () => {
    const now = new Date("2026-06-09T13:00:00Z");
    const hit = await seed("similar memory", vec(0), { createdAt: new Date("2026-06-01T00:00:00Z") });
    const miss = await seed("orthogonal memory", vec(9), { createdAt: new Date("2026-06-01T00:00:00Z") });
    const pinned = await seed("pinned goal", vec(8), { pinned: true });
    const archived = await seed("archived", vec(0), { status: "archived" });

    const result = await retrieveMemories(db, { ownerId, queryEmbedding: vec(0), k: 2, now });
    const ids = result.map((r) => r.id);
    expect(ids).toContain(pinned);
    expect(ids).toContain(hit);
    expect(ids.indexOf(hit)).toBeLessThan(ids.indexOf(miss) === -1 ? Infinity : ids.indexOf(miss));
    expect(ids).not.toContain(archived);

    const [touched] = await db.select().from(memories).where(eq(memories.id, hit));
    expect(touched!.lastUsedAt).not.toBeNull();
    const [untouchedArchived] = await db.select().from(memories).where(eq(memories.id, archived));
    expect(untouchedArchived!.lastUsedAt).toBeNull();
  });

  it("recency breaks near-ties: same similarity, newer wins", async () => {
    const now = new Date("2026-06-09T13:00:00Z");
    const old = await seed("old equal", vec(0), { createdAt: new Date("2026-01-01T00:00:00Z") });
    const fresh = await seed("fresh equal", vec(0), { createdAt: new Date("2026-06-08T00:00:00Z") });
    const result = await retrieveMemories(db, { ownerId, queryEmbedding: vec(0), k: 2, now });
    expect(result.map((r) => r.id)).toEqual([fresh, old]);
  });
});
```

- [ ] **Step 3.2:** Run `npm test -w packages/core -- memories` → FAIL. **Implement `service.ts`:**

```ts
import { and, asc, cosineDistance, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { memories, type Db } from "@mission-control/db";
import { embed } from "@mission-control/llm";
import { appendUserAction } from "../activity";

export interface CreateMemoryArgs {
  ownerId: string;
  content: string;
  source: "manual_pin" | "chat" | "extraction" | "system";
  sourceEpisodeId?: string | null;
  pinned?: boolean;
  runId?: string | null;
  embedImpl?: typeof embed;
}

// MC-201 write path: embed-then-insert. Manual pins are a user disposition,
// so they land in user_actions; system/extraction writes do not.
export async function createMemory(db: Db, args: CreateMemoryArgs): Promise<{ memoryId: string }> {
  const embedImpl = args.embedImpl ?? embed;
  const result = await embedImpl({
    db,
    ownerId: args.ownerId,
    task: "embed.memory",
    input: [args.content],
    inputType: "document",
    runId: args.runId ?? null,
    dataCategories: ["memory"],
  });
  const [row] = await db
    .insert(memories)
    .values({
      ownerId: args.ownerId,
      content: args.content,
      embedding: result.embeddings[0],
      embeddingModel: result.model,
      sourceEpisodeId: args.sourceEpisodeId ?? null,
      source: args.source,
      pinned: args.pinned ?? args.source === "manual_pin",
    })
    .returning({ id: memories.id });
  if (!row) throw new Error("memory insert returned no row");

  if (args.source === "manual_pin") {
    await appendUserAction(db, {
      ownerId: args.ownerId,
      action: "memory_pinned",
      entityType: "memory",
      entityId: row.id,
      payload: { sourceEpisodeId: args.sourceEpisodeId ?? null },
    });
  }
  return { memoryId: row.id };
}

export interface RetrieveMemoriesArgs {
  ownerId: string;
  queryEmbedding: number[];
  k?: number;
  now?: Date;
}

export interface RetrievedMemory {
  id: string;
  content: string;
  pinned: boolean;
  similarity: number | null; // null for pinned rows included regardless of vector
  score: number;
  createdAt: Date;
}

const SIMILARITY_WEIGHT = 0.8;
const RECENCY_WEIGHT = 0.2;
const RECENCY_HALF_LIFE_DAYS = 30;

// Retrieval (MC-201): cosine top-k over active memories via the HNSW index,
// blended with recency in JS (deterministic, tie-broken by id); pinned active
// memories always ride along. Touches last_used_at on everything returned.
export async function retrieveMemories(db: Db, args: RetrieveMemoriesArgs): Promise<RetrievedMemory[]> {
  const k = args.k ?? 8;
  const now = args.now ?? new Date();

  const pinnedRows = await db
    .select({ id: memories.id, content: memories.content, pinned: memories.pinned, createdAt: memories.createdAt })
    .from(memories)
    .where(and(eq(memories.ownerId, args.ownerId), eq(memories.status, "active"), eq(memories.pinned, true)))
    .orderBy(asc(memories.createdAt), asc(memories.id));

  const similarity = sql<number>`1 - (${cosineDistance(memories.embedding, args.queryEmbedding)})`;
  const candidates = await db
    .select({
      id: memories.id,
      content: memories.content,
      pinned: memories.pinned,
      createdAt: memories.createdAt,
      similarity,
    })
    .from(memories)
    .where(
      and(
        eq(memories.ownerId, args.ownerId),
        eq(memories.status, "active"),
        eq(memories.pinned, false),
        isNotNull(memories.embedding),
      ),
    )
    .orderBy(desc(similarity), asc(memories.id))
    .limit(k * 3);

  const blended = candidates
    .map((r) => {
      const ageDays = Math.max(0, (now.getTime() - r.createdAt.getTime()) / 86_400_000);
      const recency = Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
      return { ...r, similarity: Number(r.similarity), score: SIMILARITY_WEIGHT * Number(r.similarity) + RECENCY_WEIGHT * recency };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);

  const result: RetrievedMemory[] = [
    ...pinnedRows.map((p) => ({ ...p, similarity: null, score: 1 })),
    ...blended,
  ];

  const ids = result.map((r) => r.id);
  if (ids.length > 0) {
    await db
      .update(memories)
      .set({ lastUsedAt: now })
      .where(and(eq(memories.ownerId, args.ownerId), inArray(memories.id, ids)));
  }
  return result;
}
```

`memories/index.ts`: `export * from "./service";` — and add `export * from "./memories";` to `packages/core/src/index.ts`.

- [ ] **Step 3.3:** `npm test -w packages/core -- memories` → PASS; typecheck.
- [ ] **Step 3.4:** Commit: `feat(MC-201): memories service — embed-on-write, cosine+recency retrieval, lifecycle filter`

### Task 4: Pin-to-memory web surface

**Files:**
- Create: `apps/web/app/api/memories/route.ts`
- Modify: `apps/web/app/capture/capture-chat.tsx` (pin button per message)
- Test: `apps/web/src/memories-route.test.ts`

- [ ] **Step 4.1: Failing route test** (mirror `apps/web/src/capture.test.ts` harness — same cookie-jar mock, login helper):

```ts
// apps/web/src/memories-route.test.ts — copy the capture.test.ts harness verbatim
// (cookieJar vi.mock("next/headers"), OWNER_EMAIL "web-memories-test@example.com",
// beforeAll seed user, beforeEach delete memories/userActions/modelCalls rows, login()).
// The route accepts an injectable embed via a module-level setter? No — inject via
// test env: the route uses createMemory which calls embed → needs VOYAGE_API_KEY.
// Instead the route passes embedImpl only in tests via a vi.mock of @mission-control/llm:

vi.mock("@mission-control/llm", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@mission-control/llm")>();
  return {
    ...mod,
    embed: vi.fn(async (args: { input: string[] }) => ({
      embeddings: args.input.map(() => new Array(1024).fill(0)),
      model: "voyage-3.5",
      modelCallId: "00000000-0000-0000-0000-000000000000",
      costUsd: "0.000001",
      latencyMs: 1,
    })),
  };
});

describe("POST /api/memories", () => {
  it("401 without a session", async () => {
    const { POST } = await import("../app/api/memories/route");
    const res = await POST(new Request("http://x/api/memories", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    }));
    expect(res.status).toBe(401);
  });

  it("pins content → memory row + memory_pinned user action", async () => {
    await login();
    const { POST } = await import("../app/api/memories/route");
    const res = await POST(new Request("http://x/api/memories", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Prefers async updates over meetings" }),
    }));
    expect(res.status).toBe(200);
    const { memoryId } = (await res.json()) as { memoryId: string };
    const [row] = await db.select().from(memories).where(eq(memories.id, memoryId));
    expect(row).toMatchObject({ ownerId, source: "manual_pin", pinned: true });
    const [action] = await db.select().from(userActions)
      .where(eq(userActions.ownerId, ownerId)).orderBy(desc(userActions.createdAt)).limit(1);
    expect(action).toMatchObject({ action: "memory_pinned", entityId: memoryId });
  });

  it("rejects empty content", async () => {
    await login();
    const { POST } = await import("../app/api/memories/route");
    const res = await POST(new Request("http://x/api/memories", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "  " }),
    }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 4.2:** Run → FAIL. **Implement route:**

```ts
// apps/web/app/api/memories/route.ts
import { createMemory } from "@mission-control/core";
import { getDb } from "../../../src/db";
import { getSession } from "../../../src/session";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session.ownerId) return new Response("unauthorized", { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { content?: string; sourceEpisodeId?: string };
  const content = body.content?.trim();
  if (!content) return new Response("content required", { status: 400 });

  const { memoryId } = await createMemory(getDb(), {
    ownerId: session.ownerId,
    content,
    source: "manual_pin",
    sourceEpisodeId: body.sourceEpisodeId ?? null,
  });
  return Response.json({ memoryId });
}
```

(Check `src/session.ts` for the exact session helper name used by other routes — `/api/capture/route.ts` is the reference; match it.)

- [ ] **Step 4.3:** Capture-chat pin affordance — in `capture-chat.tsx`, add inside the message bubble (next to the timestamp):

```tsx
const [pinned, setPinned] = useState<Set<string>>(new Set());

async function pin(m: Message) {
  const res = await fetch("/api/memories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: m.text, sourceEpisodeId: m.id }),
  });
  if (res.ok) setPinned((p) => new Set(p).add(m.id));
}
```

and in the message JSX:

```tsx
<button
  onClick={() => void pin(m)}
  disabled={pinned.has(m.id)}
  style={{ marginLeft: 8, fontSize: 11 }}
  title="Pin to memory"
>
  {pinned.has(m.id) ? "📌 pinned" : "📌 pin"}
</button>
```

- [ ] **Step 4.4:** `npm test -w apps/web` → PASS; `npm run typecheck && npm run lint`.
- [ ] **Step 4.5:** Commit: `feat(MC-201): pin-to-memory — /api/memories + capture-chat affordance`

---

## MC-202 · ContextPacket service

### Task 5: `packages/core/src/context/` — assembly, ranking, truncation, determinism

**Files:**
- Create: `packages/core/src/context/packet.ts`, `packages/core/src/context/index.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./context";`)
- Test: `packages/core/src/context/packet.test.ts`

- [ ] **Step 5.1: Failing tests:**

```ts
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  calendarEvents, commitments, contextPackets, episodes, memories, modelCalls,
  people, userActions, users, type Db, createDb,
} from "@mission-control/db";
import { assembleContextPacket, estimateTokens, PACKET_TOKEN_BUDGET } from "./packet";

const OWNER_EMAIL = "core-context-test@example.com";
let db: Db; let ownerId: string;
const NOW = new Date("2026-06-09T13:00:00Z"); // 7:00 AM Denver
const DATE = "2026-06-09";
const QUERY = new Array(1024).fill(0);

// fake embed: deterministic query vector, no model_calls row needed for assembly tests
const fakeEmbed = (async (args: { input: string[] }) => ({
  embeddings: args.input.map(() => QUERY),
  model: "voyage-3.5",
  modelCallId: "00000000-0000-0000-0000-000000000000",
  costUsd: "0", latencyMs: 1,
})) as never;

beforeAll(async () => { /* standard harness — seed user, capture ownerId */ });
beforeEach(async () => {
  for (const t of [contextPackets, commitments, calendarEvents, episodes, memories, userActions, modelCalls])
    await db.delete(t).where(eq((t as typeof commitments).ownerId, ownerId));
  await db.delete(people).where(eq(people.ownerId, ownerId));
});

describe("assembleContextPacket", () => {
  it("ranks open commitments by due date asc nulls last, then age, and includes today's schedule", async () => {
    await db.insert(commitments).values([
      { ownerId, direction: "owed_by_me", description: "no due date — oldest", sourceType: "manual", status: "open", createdAt: new Date("2026-06-01T00:00:00Z") },
      { ownerId, direction: "owed_by_me", description: "due tomorrow", sourceType: "manual", status: "open", dueDate: "2026-06-10", createdAt: new Date("2026-06-08T00:00:00Z") },
      { ownerId, direction: "owed_by_me", description: "due today", sourceType: "manual", status: "open", dueDate: "2026-06-09", createdAt: new Date("2026-06-08T00:00:00Z") },
      { ownerId, direction: "owed_by_me", description: "candidate — excluded", sourceType: "manual", status: "candidate" },
      { ownerId, direction: "owed_by_me", description: "overdue", sourceType: "manual", status: "open", dueDate: "2026-06-05", createdAt: new Date("2026-06-08T00:00:00Z") },
    ]);
    await db.insert(calendarEvents).values([
      { ownerId, gcalEventId: "ev-today", title: "Standup", startsAt: new Date("2026-06-09T15:00:00Z"), endsAt: new Date("2026-06-09T15:30:00Z") },
      { ownerId, gcalEventId: "ev-tomorrow", title: "Future", startsAt: new Date("2026-06-10T15:00:00Z") },
      { ownerId, gcalEventId: "ev-cancelled", title: "Gone", startsAt: new Date("2026-06-09T17:00:00Z"), status: "cancelled" },
    ]);

    const { packet } = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, embedImpl: fakeEmbed });
    expect(packet.commitments.map((c) => c.description)).toEqual([
      "overdue", "due today", "due tomorrow", "no due date — oldest",
    ]);
    expect(packet.commitments[0]!.overdue).toBe(true);
    expect(packet.commitments[1]!.overdue).toBe(false);
    expect(packet.schedule.map((s) => s.title)).toEqual(["Standup"]);
  });

  it("is byte-identical for identical inputs (determinism)", async () => {
    await db.insert(commitments).values({ ownerId, direction: "owed_by_me", description: "d", sourceType: "manual", status: "open" });
    const a = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, embedImpl: fakeEmbed });
    const b = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, embedImpl: fakeEmbed });
    expect(JSON.stringify(a.packet)).toBe(JSON.stringify(b.packet));
  });

  it("persists the packet row exactly as returned", async () => {
    const { packetId, packet } = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, embedImpl: fakeEmbed });
    const [row] = await db.select().from(contextPackets).where(eq(contextPackets.id, packetId));
    expect(row).toMatchObject({ ownerId, task: "cos.morning_brief" });
    expect(JSON.stringify(row!.content)).toBe(JSON.stringify(packet));
  });

  it("truncates episodes first, then non-pinned memories, never pinned, and records truncations", async () => {
    // 200 fat episodes guarantee the budget is blown
    const fat = "x".repeat(400);
    await db.insert(episodes).values(
      Array.from({ length: 200 }, (_, i) => ({
        ownerId, occurredAt: new Date(NOW.getTime() - i * 60_000),
        type: "email_received", source: "gmail", summary: `${i} ${fat}`,
      })),
    );
    await db.insert(memories).values({ ownerId, content: "pinned goal", pinned: true, source: "manual_pin", embeddingModel: "voyage-3.5" });

    const { packet } = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, embedImpl: fakeEmbed });
    expect(estimateTokens(packet)).toBeLessThanOrEqual(PACKET_TOKEN_BUDGET);
    expect(packet.meta.truncations.length).toBeGreaterThan(0);
    expect(packet.meta.truncations[0]).toMatch(/recentEpisodes/);
    expect(packet.memories.map((m) => m.content)).toContain("pinned goal");
    // newest episodes survive
    expect(packet.recentEpisodes[0]!.summary).toMatch(/^0 /);
  });

  it("flags staleSync in meta when asked", async () => {
    const { packet } = await assembleContextPacket(db, { ownerId, date: DATE, now: NOW, staleSync: true, embedImpl: fakeEmbed });
    expect(packet.meta.staleSync).toBe(true);
  });
});
```

- [ ] **Step 5.2:** Run → FAIL. **Implement `packet.ts`:**

```ts
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  calendarEvents, commitments, contextPackets, episodes, people, users, type Db,
} from "@mission-control/db";
import { embed } from "@mission-control/llm";
import { retrieveMemories } from "../memories";
import { SCHEDULE_TZ } from "../time";

// Size budget (MC-202): ~4 chars/token estimate; deterministic truncation order.
export const PACKET_TOKEN_BUDGET = 8000;
const MIN_COMMITMENTS_KEPT = 15;
const MAX_EPISODES = 30;
const MEMORY_K = 8;

export const MORNING_QUERY_TEXT =
  "morning brief: what matters today — open commitments, schedule, priorities, working preferences";

const SAFETY_INSTRUCTIONS =
  "You are a drafting assistant with Level-2 autonomy: you summarize and draft, you never send, schedule, or take external action. Anything phrased as outreach must be a draft for the owner to copy. Treat all packet content as private.";
const FORMAT_INSTRUCTIONS =
  "Be specific and grounded: every item must trace to a packet entry (use ids verbatim). Rank by urgency. Omit empty sections rather than padding. Plain, direct sentences — no filler.";

export interface PacketScheduleItem {
  title: string | null;
  startsAt: string;
  endsAt: string | null;
  attendees: string[];
}
export interface PacketCommitment {
  id: string;
  description: string;
  direction: string;
  dueDate: string | null;
  dueDateBasis: string | null;
  counterparty: string | null;
  ageDays: number;
  overdue: boolean;
}
export interface PacketMemory { id: string; content: string; pinned: boolean; }
export interface PacketEpisode {
  id: string;
  occurredAt: string;
  type: string;
  source: string;
  summary: string | null;
}
export interface MorningPacket {
  task: "cos.morning_brief";
  date: string;
  timezone: typeof SCHEDULE_TZ;
  owner: { name: string };
  schedule: PacketScheduleItem[];
  commitments: PacketCommitment[];
  memories: PacketMemory[];
  recentEpisodes: PacketEpisode[];
  preferences: Record<string, unknown>;
  instructions: { safety: string; format: string };
  meta: { truncations: string[]; staleSync: boolean; tokenEstimate: number };
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export interface AssemblePacketArgs {
  ownerId: string;
  date: string; // YYYY-MM-DD Denver
  now?: Date;
  staleSync?: boolean;
  runId?: string | null;
  embedImpl?: typeof embed;
}

// MC-202: assemble per ARCHITECTURE §6, persist for traceability, return both.
// Determinism contract: same DB state + same (date, now) → byte-identical packet.
export async function assembleContextPacket(
  db: Db,
  args: AssemblePacketArgs,
): Promise<{ packetId: string; packet: MorningPacket }> {
  const now = args.now ?? new Date();
  const embedImpl = args.embedImpl ?? embed;

  const [owner] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, args.ownerId));
  if (!owner) throw new Error(`owner ${args.ownerId} not found`);

  // 1. today's schedule — Denver-day bounds computed in SQL
  const dayStart = sql`((${args.date})::date)::timestamp at time zone ${sql.raw(`'${SCHEDULE_TZ}'`)}`;
  const dayEnd = sql`(((${args.date})::date + 1))::timestamp at time zone ${sql.raw(`'${SCHEDULE_TZ}'`)}`;
  const events = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.ownerId, args.ownerId),
        eq(calendarEvents.status, "confirmed"),
        gte(calendarEvents.startsAt, dayStart),
        sql`${calendarEvents.startsAt} < ${dayEnd}`,
      ),
    )
    .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.gcalEventId));
  const schedule: PacketScheduleItem[] = events.map((e) => ({
    title: e.title,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt?.toISOString() ?? null,
    attendees: Array.isArray(e.attendees)
      ? (e.attendees as { email?: string; displayName?: string }[]).map(
          (a) => a.displayName ?? a.email ?? "unknown",
        )
      : [],
  }));

  // 2. open commitments ranked: due asc nulls last, then age, then counterparty recency
  const awake = or(isNull(commitments.snoozedUntil), lte(commitments.snoozedUntil, sql`now()`));
  const rows = await db
    .select({
      id: commitments.id,
      description: commitments.description,
      direction: commitments.direction,
      dueDate: commitments.dueDate,
      dueDateBasis: commitments.dueDateBasis,
      createdAt: commitments.createdAt,
      counterparty: people.displayName,
    })
    .from(commitments)
    .leftJoin(people, eq(commitments.counterpartyPersonId, people.id))
    .where(and(eq(commitments.ownerId, args.ownerId), eq(commitments.status, "open"), awake))
    .orderBy(
      sql`${commitments.dueDate} asc nulls last`,
      asc(commitments.createdAt),
      sql`${people.lastContactAt} desc nulls last`,
      asc(commitments.id),
    );
  const packetCommitments: PacketCommitment[] = rows.map((r) => ({
    id: r.id,
    description: r.description,
    direction: r.direction,
    dueDate: r.dueDate,
    dueDateBasis: r.dueDateBasis,
    counterparty: r.counterparty,
    ageDays: Math.max(0, Math.floor((now.getTime() - r.createdAt.getTime()) / 86_400_000)),
    overdue: r.dueDate !== null && r.dueDate < args.date,
  }));

  // 3. memories: pinned always + vector top-k against the task-shaped query
  const { embeddings } = await embedImpl({
    db,
    ownerId: args.ownerId,
    task: "embed.query",
    input: [MORNING_QUERY_TEXT],
    inputType: "query",
    runId: args.runId ?? null,
    dataCategories: ["memory"],
  });
  const retrieved = await retrieveMemories(db, {
    ownerId: args.ownerId,
    queryEmbedding: embeddings[0]!,
    k: MEMORY_K,
    now,
  });
  const packetMemories: PacketMemory[] = retrieved.map((m) => ({
    id: m.id,
    content: m.content,
    pinned: m.pinned,
  }));

  // 4. related episodes: last 24 h, newest first
  const recent = await db
    .select({
      id: episodes.id,
      occurredAt: episodes.occurredAt,
      type: episodes.type,
      source: episodes.source,
      summary: episodes.summary,
    })
    .from(episodes)
    .where(
      and(eq(episodes.ownerId, args.ownerId), gte(episodes.occurredAt, new Date(now.getTime() - 86_400_000))),
    )
    .orderBy(desc(episodes.occurredAt), asc(episodes.id))
    .limit(MAX_EPISODES);
  const recentEpisodes: PacketEpisode[] = recent.map((e) => ({
    id: e.id,
    occurredAt: e.occurredAt.toISOString(),
    type: e.type,
    source: e.source,
    summary: e.summary,
  }));

  // 5. preferences (sorted by key for determinism)
  const prefRows = await db.execute(
    sql`select key, value from user_preferences where owner_id = ${args.ownerId} order by key`,
  );
  const preferences: Record<string, unknown> = {};
  for (const r of prefRows.rows as { key: string; value: unknown }[]) preferences[r.key] = r.value;

  const packet: MorningPacket = {
    task: "cos.morning_brief",
    date: args.date,
    timezone: SCHEDULE_TZ,
    owner: { name: owner.displayName },
    schedule,
    commitments: packetCommitments,
    memories: packetMemories,
    recentEpisodes,
    preferences,
    instructions: { safety: SAFETY_INSTRUCTIONS, format: FORMAT_INSTRUCTIONS },
    meta: { truncations: [], staleSync: args.staleSync ?? false, tokenEstimate: 0 },
  };

  // 6. budget enforcement — deterministic truncation order (MC-202):
  //    episodes (oldest first) → non-pinned memories (lowest rank first) → commitments
  //    (lowest rank first, never below MIN_COMMITMENTS_KEPT). Pinned memories never drop.
  const dropped = { recentEpisodes: 0, memories: 0, commitments: 0 };
  while (estimateTokens(packet) > PACKET_TOKEN_BUDGET) {
    if (packet.recentEpisodes.length > 0) {
      packet.recentEpisodes.pop();
      dropped.recentEpisodes++;
    } else if (packet.memories.some((m) => !m.pinned)) {
      for (let i = packet.memories.length - 1; i >= 0; i--) {
        if (!packet.memories[i]!.pinned) {
          packet.memories.splice(i, 1);
          dropped.memories++;
          break;
        }
      }
    } else if (packet.commitments.length > MIN_COMMITMENTS_KEPT) {
      packet.commitments.pop();
      dropped.commitments++;
    } else {
      packet.meta.truncations.push("over_budget: floor reached, sending anyway");
      break;
    }
  }
  for (const [k, n] of Object.entries(dropped)) {
    if (n > 0) packet.meta.truncations.unshift(`${k}: dropped ${n}`);
  }
  packet.meta.tokenEstimate = estimateTokens(packet);

  const [inserted] = await db
    .insert(contextPackets)
    .values({ ownerId: args.ownerId, task: packet.task, content: packet })
    .returning({ id: contextPackets.id });
  if (!inserted) throw new Error("context packet insert returned no row");
  return { packetId: inserted.id, packet };
}
```

`context/index.ts`: `export * from "./packet";`

**Note on `db.execute`:** if the Drizzle pg driver returns `{ rows }` differently, use the typed `userPreferences` table select instead (`db.select().from(userPreferences).where(eq(...)).orderBy(asc(userPreferences.key))`) — prefer the typed version; the raw SQL above is the fallback.

- [ ] **Step 5.3:** Run tests → PASS; typecheck + lint.
- [ ] **Step 5.4:** Commit: `feat(MC-202): ContextPacket service — ranked assembly, token budget, deterministic truncation`

---

## MC-203 · Real morning brief

### Task 6: Prompt module + tier registration + prompt-version registry

**Files:**
- Modify: `packages/llm/src/config.ts` (one line: `"cos.morning_brief": "top"` in `TASK_TIERS`)
- Create: `packages/core/src/briefs/morning_brief.v1.ts`
- Create: `packages/core/src/briefs/active.ts`
- Create: `packages/core/src/briefs/prompt-registry.ts`
- Modify: `packages/core/src/briefs/index.ts`, `apps/worker/src/index.ts`
- Test: `packages/core/src/briefs/morning-prompt.test.ts`

**DO NOT touch `packages/core/src/extraction/**` — import `ACTIVE_EXTRACTION` from there read-only.**

- [ ] **Step 6.1: Failing test** — `morning-prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveTask } from "@mission-control/llm";
import { MorningBriefOutput, morningBriefV1 } from "./morning_brief.v1";
import { ACTIVE_MORNING_BRIEF } from "./active";

describe("cos.morning_brief v1", () => {
  it("is registered on the top tier", () => {
    expect(resolveTask("cos.morning_brief")).toMatchObject({ tier: "top", model: "claude-opus-4-8" });
  });

  it("active version is v1 with a stable content hash", () => {
    expect(ACTIVE_MORNING_BRIEF.version).toBe("v1");
    expect(ACTIVE_MORNING_BRIEF.contentHash()).toBe(morningBriefV1.contentHash());
    expect(morningBriefV1.contentHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("schema accepts a well-formed brief and rejects a sectionless one", () => {
    expect(
      MorningBriefOutput.safeParse({
        headline: "Tight morning: two deadlines and a 9:30 standup.",
        top_commitments: [{ commitment_id: null, description: "send contract", due_date: "2026-06-09", why_now: "due today" }],
        schedule: [{ time: "09:30", title: "Standup", prep_pointer: null }],
        waiting_on: [{ commitment_id: null, description: "revised deck", counterparty: "Sara", nudge_draft: "Hi Sara — any update on the revised deck?" }],
        slipped: [],
      }).success,
    ).toBe(true);
    expect(MorningBriefOutput.safeParse({ headline: "" }).success).toBe(false);
  });

  it("renderPrompt includes the packet JSON and flags stale sync", () => {
    const packet = {
      task: "cos.morning_brief", date: "2026-06-09", timezone: "America/Denver",
      owner: { name: "Mark" }, schedule: [], commitments: [], memories: [], recentEpisodes: [],
      preferences: {}, instructions: { safety: "s", format: "f" },
      meta: { truncations: [], staleSync: true, tokenEstimate: 100 },
    };
    const prompt = morningBriefV1.renderPrompt(packet as never);
    expect(prompt).toContain("2026-06-09");
    expect(prompt).toContain("CONTEXT PACKET");
    expect(prompt).toMatch(/stale/i);
  });
});
```

- [ ] **Step 6.2:** Run → FAIL. **Implement.** `config.ts`: add `"cos.morning_brief": "top",` to `TASK_TIERS`. Then `morning_brief.v1.ts`:

```ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { MorningPacket } from "../context/packet";

// cos.morning_brief v1 — prompt + schema live together, versioned as a module
// (CLAUDE.md conventions). Active version referenced only in ./active.ts.

export const BriefCommitmentItem = z.object({
  commitment_id: z.string().nullable(), // packet commitment id, verbatim — null only for items not in the packet
  description: z.string().min(1),
  due_date: z.string().nullable(),
  why_now: z.string().nullable(),
});
export const BriefScheduleItem = z.object({
  time: z.string().min(1), // local Denver time, e.g. "09:30"
  title: z.string().min(1),
  prep_pointer: z.string().nullable(), // what to glance at before walking in
});
export const BriefWaitingItem = z.object({
  commitment_id: z.string().nullable(),
  description: z.string().min(1),
  counterparty: z.string().nullable(),
  nudge_draft: z.string().min(1), // a DRAFT for the owner to copy — never sent
});
export const BriefSlippedItem = z.object({
  commitment_id: z.string().nullable(),
  description: z.string().min(1),
  due_date: z.string().nullable(),
});

export const MorningBriefOutput = z.object({
  headline: z.string().min(1),
  top_commitments: z.array(BriefCommitmentItem).max(7),
  schedule: z.array(BriefScheduleItem),
  waiting_on: z.array(BriefWaitingItem),
  slipped: z.array(BriefSlippedItem),
});
export type MorningBriefOutputT = z.infer<typeof MorningBriefOutput>;

const SYSTEM = `You are the owner's chief of staff writing their morning brief. You work from ONE context packet (JSON) and nothing else.

Hard rules:
- Level-2 autonomy: you draft and summarize; you never send, schedule, or act. Every "nudge_draft" is a draft the owner may copy — write it in the owner's voice to the counterparty, but you are NOT sending it.
- Ground every item in the packet. When an item comes from a packet commitment, copy its "id" into commitment_id verbatim. Never invent commitments, meetings, or people.
- The packet's commitments arrive pre-ranked (due date, then age, then counterparty recency). top_commitments is your judgment over that ranking — at most 7, fewer is better.
- schedule: one entry per packet schedule item, time as Denver local "HH:MM". prep_pointer only when the packet gives you something concrete (a related commitment or memory); otherwise null.
- waiting_on: packet commitments with direction "owed_to_me" worth nudging today.
- slipped: packet commitments whose overdue flag is true.
- headline: one or two sentences, the day's shape. If meta.staleSync is true, say the inbox/calendar sync failed and data may be stale.
- Respect instructions.safety and instructions.format from the packet. Precision over completeness — empty sections are fine. Always respond by calling the tool exactly once.`;

function renderPrompt(packet: MorningPacket): string {
  return [
    `Write the morning brief for ${packet.date} (${packet.timezone}) for ${packet.owner.name}.`,
    ...(packet.meta.staleSync
      ? ["NOTE: this morning's pre-sync failed — packet data may be stale; say so in the headline."]
      : []),
    "",
    "CONTEXT PACKET (JSON):",
    JSON.stringify(packet, null, 2),
  ].join("\n");
}

export const morningBriefV1 = {
  task: "cos.morning_brief" as const,
  version: "v1" as const,
  schema: MorningBriefOutput,
  system: SYSTEM,
  renderPrompt,
  contentHash(): string {
    return createHash("sha256")
      .update(SYSTEM)
      .update(JSON.stringify(z.toJSONSchema(MorningBriefOutput)))
      .digest("hex");
  },
};
export type MorningBriefPromptModule = typeof morningBriefV1;
```

`briefs/active.ts`:

```ts
import { morningBriefV1, type MorningBriefPromptModule } from "./morning_brief.v1";

// THE single config place for the active morning-brief version (CLAUDE.md conventions).
export const ACTIVE_MORNING_BRIEF: MorningBriefPromptModule = morningBriefV1;
```

`briefs/prompt-registry.ts`:

```ts
import { promptVersions, type Db } from "@mission-control/db";
import { ACTIVE_EXTRACTION } from "../extraction/active";
import { ACTIVE_MORNING_BRIEF } from "./active";

// Worker-startup registration for every active prompt module (MC-203 extends
// MC-104's recordPromptVersion, which stays untouched — its path is eval-gated).
export async function recordActivePromptVersions(db: Db): Promise<void> {
  for (const mod of [ACTIVE_EXTRACTION, ACTIVE_MORNING_BRIEF] as const) {
    await db
      .insert(promptVersions)
      .values({ task: mod.task, version: mod.version, contentHash: mod.contentHash() })
      .onConflictDoNothing();
  }
}
```

`briefs/index.ts`: add the three new exports. `apps/worker/src/index.ts`: replace `recordPromptVersion(db)` with `recordActivePromptVersions(db)` (update import; comment: "all active prompt versions are registered").

- [ ] **Step 6.3:** Tests pass; typecheck both packages; commit: `feat(MC-203): cos.morning_brief v1 prompt module — top tier, versioned, startup-registered`

### Task 7: Markdown renderer

**Files:**
- Create: `packages/core/src/briefs/render-morning.ts`
- Modify: `packages/core/src/briefs/index.ts`
- Test: `packages/core/src/briefs/render-morning.test.ts` (file snapshots, like `render.test.ts`)

- [ ] **Step 7.1: Failing snapshot test:**

```ts
import { describe, expect, it } from "vitest";
import { renderMorningBriefMd } from "./render-morning";

const full = {
  headline: "Tight morning: contract due today, standup at 9:30.",
  top_commitments: [
    { commitment_id: "c1", description: "send Sara the contract", due_date: "2026-06-09", why_now: "due today" },
    { commitment_id: null, description: "review Q3 plan", due_date: null, why_now: null },
  ],
  schedule: [
    { time: "09:30", title: "Standup", prep_pointer: "skim yesterday's capture notes" },
    { time: "14:00", title: "1:1 with Dana", prep_pointer: null },
  ],
  waiting_on: [
    { commitment_id: "c2", description: "revised deck", counterparty: "Sara", nudge_draft: "Hi Sara — any update on the revised deck?" },
  ],
  slipped: [{ commitment_id: "c3", description: "intro Dana to Priya", due_date: "2026-06-05" }],
};

describe("renderMorningBriefMd", () => {
  it("renders all sections", () => {
    expect(renderMorningBriefMd(full, "2026-06-09")).toMatchSnapshot();
  });
  it("omits empty sections", () => {
    expect(
      renderMorningBriefMd(
        { headline: "Quiet day.", top_commitments: [], schedule: [], waiting_on: [], slipped: [] },
        "2026-06-09",
      ),
    ).toMatchSnapshot();
  });
});
```

- [ ] **Step 7.2:** Run → FAIL. **Implement `render-morning.ts`:**

```ts
import type { MorningBriefOutputT } from "./morning_brief.v1";

// JSON→markdown for the reader fallback + email mirror (MC-203). The reader's
// primary path renders content_json structurally; this stays dependency-free.
export function renderMorningBriefMd(content: MorningBriefOutputT, date: string): string {
  const lines: string[] = [`# Morning Brief — ${date}`, "", content.headline, ""];

  if (content.schedule.length > 0) {
    lines.push("## Today");
    for (const s of content.schedule)
      lines.push(`- **${s.time}** ${s.title}${s.prep_pointer ? ` — ${s.prep_pointer}` : ""}`);
    lines.push("");
  }
  if (content.top_commitments.length > 0) {
    lines.push("## Top commitments");
    for (const c of content.top_commitments)
      lines.push(
        `- ${c.description}${c.due_date ? ` (due ${c.due_date})` : ""}${c.why_now ? ` — ${c.why_now}` : ""}`,
      );
    lines.push("");
  }
  if (content.waiting_on.length > 0) {
    lines.push("## Waiting on");
    for (const w of content.waiting_on) {
      lines.push(`- ${w.description}${w.counterparty ? ` — ${w.counterparty}` : ""}`);
      lines.push(`  > draft nudge: ${w.nudge_draft}`);
    }
    lines.push("");
  }
  if (content.slipped.length > 0) {
    lines.push("## Slipped");
    for (const s of content.slipped)
      lines.push(`- ${s.description}${s.due_date ? ` (was due ${s.due_date})` : ""}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
```

- [ ] **Step 7.3:** Run twice (write snapshot, then verify stable) → PASS. Commit: `feat(MC-203): morning brief markdown renderer`

### Task 8: `generateMorningBrief` service

**Files:**
- Create: `packages/core/src/briefs/morning.ts`
- Modify: `packages/core/src/briefs/index.ts`
- Test: `packages/core/src/briefs/morning.test.ts`

- [ ] **Step 8.1: Failing tests** (standard DB harness; `fakeComplete` returns a fixed `MorningBriefOutputT`):

```ts
// cases:
// 1. happy path: creates packet + brief; brief row has kind "morning", dedupeKey
//    "morning:<date>", contentJson matching fakeComplete's data, contentMd containing
//    the headline, contextPacketId pointing at a context_packets row, cadenceRunId set.
// 2. idempotency: second call with same date → { created: false, briefId: same }, and
//    completeImpl was NOT called again (vi.fn call count stays 1).
// 3. generation failure: completeImpl rejects → generateMorningBrief rejects AND no
//    briefs row exists for the dedupe key (the packet row may exist — that's fine).
const fakeOutput = {
  headline: "Test headline.",
  top_commitments: [], schedule: [], waiting_on: [], slipped: [],
};
const fakeComplete = vi.fn(async () => ({
  data: fakeOutput, modelCallId: "00000000-0000-0000-0000-000000000000",
  costUsd: "0.01", latencyMs: 5,
}));
const fakeEmbed = /* same shape as packet.test.ts fakeEmbed */;

it("creates packet + brief and converges on re-run", async () => {
  const first = await generateMorningBrief(db, {
    ownerId, date: "2026-06-09", completeImpl: fakeComplete as never, embedImpl: fakeEmbed,
  });
  expect(first.created).toBe(true);
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, first.briefId));
  expect(brief).toMatchObject({ kind: "morning", dedupeKey: "morning:2026-06-09" });
  expect(brief!.contentJson).toMatchObject({ headline: "Test headline." });
  expect(brief!.contentMd).toContain("Test headline.");

  const again = await generateMorningBrief(db, {
    ownerId, date: "2026-06-09", completeImpl: fakeComplete as never, embedImpl: fakeEmbed,
  });
  expect(again).toEqual({ created: false, briefId: first.briefId });
  expect(fakeComplete).toHaveBeenCalledTimes(1);
});

it("generation failure → no brief row", async () => {
  const boom = vi.fn(async () => { throw new Error("opus unavailable"); });
  await expect(
    generateMorningBrief(db, { ownerId, date: "2026-06-09", completeImpl: boom as never, embedImpl: fakeEmbed }),
  ).rejects.toThrow("opus unavailable");
  expect(await db.select().from(briefs).where(eq(briefs.ownerId, ownerId))).toHaveLength(0);
});
```

- [ ] **Step 8.2:** Run → FAIL. **Implement `morning.ts`:**

```ts
import { and, eq } from "drizzle-orm";
import { briefs, type Db } from "@mission-control/db";
import { complete, embed } from "@mission-control/llm";
import { assembleContextPacket } from "../context/packet";
import { ACTIVE_MORNING_BRIEF } from "./active";
import { renderMorningBriefMd } from "./render-morning";

export interface MorningBriefArgs {
  ownerId: string;
  date: string; // YYYY-MM-DD Denver → dedupe key "morning:<date>"
  cadenceRunId?: string;
  staleSync?: boolean;
  now?: Date;
  completeImpl?: typeof complete;
  embedImpl?: typeof embed;
}

export interface MorningBriefResult {
  created: boolean;
  briefId: string;
}

// MC-203: replaces generateHelloBrief on the morning_brief job. Same two-layer
// idempotency as hello (dedupe check → unique-index converge). Generation failure
// throws BEFORE any brief insert: failed run, no brief row, no notify.
export async function generateMorningBrief(db: Db, args: MorningBriefArgs): Promise<MorningBriefResult> {
  const dedupeKey = `morning:${args.date}`;
  const findExisting = () =>
    db
      .select({ id: briefs.id })
      .from(briefs)
      .where(and(eq(briefs.ownerId, args.ownerId), eq(briefs.dedupeKey, dedupeKey)));

  const [existing] = await findExisting();
  if (existing) return { created: false, briefId: existing.id };

  const { packetId, packet } = await assembleContextPacket(db, {
    ownerId: args.ownerId,
    date: args.date,
    now: args.now,
    staleSync: args.staleSync,
    runId: args.cadenceRunId ?? null,
    embedImpl: args.embedImpl,
  });

  const completeImpl = args.completeImpl ?? complete;
  const { data } = await completeImpl({
    db,
    ownerId: args.ownerId,
    task: ACTIVE_MORNING_BRIEF.task,
    schema: ACTIVE_MORNING_BRIEF.schema,
    system: ACTIVE_MORNING_BRIEF.system,
    prompt: ACTIVE_MORNING_BRIEF.renderPrompt(packet),
    maxTokens: 8192,
    runId: args.cadenceRunId ?? null,
    promptVersion: ACTIVE_MORNING_BRIEF.version,
    dataCategories: ["email", "calendar", "memory", "commitment"],
  });

  const contentMd = renderMorningBriefMd(data, args.date);
  const [inserted] = await db
    .insert(briefs)
    .values({
      ownerId: args.ownerId,
      kind: "morning",
      dedupeKey,
      contentJson: data,
      contentMd,
      contextPacketId: packetId,
      cadenceRunId: args.cadenceRunId,
    })
    .onConflictDoNothing()
    .returning({ id: briefs.id });

  if (!inserted) {
    const [winner] = await findExisting();
    if (!winner) throw new Error(`brief conflict but no row found for ${dedupeKey}`);
    return { created: false, briefId: winner.id };
  }
  return { created: true, briefId: inserted.id };
}
```

- [ ] **Step 8.3:** Tests PASS; commit: `feat(MC-203): generateMorningBrief — packet → Opus → brief, fail-closed`

### Task 9: Worker — pre-sync + wire the real brief

**Files:**
- Modify: `apps/worker/src/jobs/briefs.ts`
- Test: `apps/worker/src/jobs/briefs.test.ts` (new file, mirror `ingest.test.ts` harness style)

- [ ] **Step 9.1: Failing tests** — key cases:

```ts
// 1. morning_brief with no google accounts: presync step recorded ok (accounts: 0),
//    generateImpl called with staleSync=false, notify enqueued when created=true.
// 2. presync failure (syncGmailImpl throws): presync run_step status "failed",
//    generateImpl still called with staleSync=true, run still succeeds.
// 3. generateImpl throws: run fails (cadence_runs status "failed"), no notify job enqueued.
// 4. created=false (re-run): no notify enqueued.
// Build a JobContext with real db + real (or stubbed) queues; pass BriefsDeps
// { generateImpl, syncGmailImpl, syncGcalImpl } fakes; invoke the processor with a
// fake BullMQ job object: { name: "morning_brief", id: "morning-brief-2026-06-09",
// data: { date: "2026-06-09" }, attemptsMade: 0 }.
// Assert run_steps via: select from runSteps join cadenceRuns where jobName='morning_brief'.
```

- [ ] **Step 9.2:** Run → FAIL. **Rewrite `briefs.ts` `morning_brief` case:**

```ts
import type { Processor } from "bullmq";
import {
  appendRunStep,
  createGcalClient,
  createGmailClient,
  dateKeyInDenver,
  generateMorningBrief,
  getValidAccessToken,
  listGoogleAccounts,
  syncGcal,
  syncGmail,
  withCadenceRun,
} from "@mission-control/core";
import type { JobContext } from "./index";

export interface BriefsDeps {
  generateImpl?: typeof generateMorningBrief;
  syncGmailImpl?: typeof syncGmail;
  syncGcalImpl?: typeof syncGcal;
}

export function makeBriefsProcessor(ctx: JobContext, deps: BriefsDeps = {}): Processor {
  return async (job) => {
    switch (job.name) {
      case "morning_brief_tick": {
        /* unchanged from Phase 0 */
      }

      case "morning_brief": {
        const date: string = (job.data as { date?: string })?.date ?? dateKeyInDenver();
        const jobId = job.id ?? `morning-brief-${date}`;
        return withCadenceRun(
          ctx.db,
          { ownerId: ctx.owner.id, jobName: "morning_brief", jobId, attempt: job.attemptsMade + 1 },
          async (runId) => {
            // step 1: inline pre-sync — 7 AM is outside the ingest window (ARCHITECTURE §5.1).
            // Failure degrades to stale data; it never skips the brief.
            const presyncStart = new Date();
            let staleSync = false;
            const detail: Record<string, unknown> = {};
            try {
              const accounts = await listGoogleAccounts(ctx.db, ctx.owner.id);
              detail.accounts = accounts.length;
              for (const account of accounts) {
                if (account.status === "reauth_required") {
                  staleSync = true;
                  detail[account.email] = "reauth_required";
                  continue;
                }
                const gmailClient = createGmailClient(() =>
                  getValidAccessToken(ctx.db, ctx.owner.id, account.id),
                );
                const gmail = await (deps.syncGmailImpl ?? syncGmail)(ctx.db, ctx.owner.id, account.id, {
                  client: gmailClient,
                });
                for (const episodeId of gmail.extractEpisodeIds) {
                  await ctx.queues.extraction.add(
                    "extract_commitments",
                    { episodeId },
                    { jobId: `extract-episode-${episodeId}` },
                  );
                }
                const gcalClient = createGcalClient(() =>
                  getValidAccessToken(ctx.db, ctx.owner.id, account.id),
                );
                await (deps.syncGcalImpl ?? syncGcal)(ctx.db, ctx.owner.id, account.id, {
                  client: gcalClient,
                });
                detail[account.email] = "synced";
              }
            } catch (err) {
              staleSync = true;
              detail.error = String(err);
            }
            await appendRunStep(ctx.db, {
              runId,
              seq: 1,
              name: "presync",
              status: staleSync ? "failed" : "ok",
              startedAt: presyncStart,
              detail,
            });

            // step 2: assemble + generate. A throw here fails the run — no brief, no notify.
            const generate = deps.generateImpl ?? generateMorningBrief;
            const result = await generate(ctx.db, {
              ownerId: ctx.owner.id,
              date,
              cadenceRunId: runId,
              staleSync,
            });
            if (result.created) {
              await ctx.queues.notify.add(
                "deliver_brief",
                { briefId: result.briefId },
                { jobId: `notify-${result.briefId}` },
              );
            }
            return { ...result, staleSync };
          },
        );
      }

      default:
        throw new Error(`unknown briefs job "${job.name}" (${job.id})`);
    }
  };
}
```

(Keep the `morning_brief_tick` case byte-identical to today's. `generateHelloBrief` stays in core — its tests still pass — but the worker no longer imports it.)

- [ ] **Step 9.3:** `npm test -w apps/worker` → PASS (including pre-existing tests); typecheck; commit: `feat(MC-203): morning_brief job — inline pre-sync, real generation, fail-closed notify`

### Task 10: Reader upgrade, `opened_at`, debug view

**Files:**
- Modify: `packages/core/src/briefs/delivery.ts` (`markBriefOpened` returns `boolean`)
- Modify: `packages/core/src/briefs/hello.test.ts`/wherever delivery tests live — add opened-once test (find existing delivery test file; if none, add `delivery.test.ts`)
- Modify: `apps/web/app/briefs/[id]/page.tsx`
- Create: `apps/web/app/briefs/[id]/debug/page.tsx`
- Modify: `apps/web/src/queries.ts` (`getContextPacket`, `listCommitmentSources`)
- Test: `apps/web/src/brief-reader.test.ts`

- [ ] **Step 10.1:** `markBriefOpened` → returning + boolean:

```ts
export async function markBriefOpened(db: Db, ownerId: string, briefId: string): Promise<boolean> {
  const rows = await db
    .update(briefs)
    .set({ openedAt: new Date() })
    .where(and(eq(briefs.ownerId, ownerId), eq(briefs.id, briefId), isNull(briefs.openedAt)))
    .returning({ id: briefs.id });
  return rows.length > 0;
}
```

Core test: first call returns `true` and sets `openedAt`; second returns `false` and `openedAt` is unchanged (capture value between calls).

- [ ] **Step 10.2: Failing web test** — `brief-reader.test.ts` (capture.test.ts harness): seed a brief (+packet) directly, then:

```ts
// 1. rendering the reader page (import the default export, call it with
//    { params: Promise.resolve({ id: briefId }) }) sets opened_at and writes exactly
//    one brief_opened user_action;
// 2. rendering it AGAIN leaves opened_at unchanged and writes NO second user_action.
// (RSC pages are async functions returning JSX — awaiting them in a test is enough;
// assert on DB state, not markup.)
```

- [ ] **Step 10.3: Implement reader** — `apps/web/app/briefs/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { appendUserAction, markBriefOpened, MorningBriefOutput } from "@mission-control/core";
import { getDb } from "../../../src/db";
import { getBrief } from "../../../src/queries";
import { requireOwnerId } from "../../../src/session";

export const dynamic = "force-dynamic";

export default async function BriefReaderPage({ params }: { params: Promise<{ id: string }> }) {
  const ownerId = await requireOwnerId();
  const { id } = await params;
  const db = getDb();
  const brief = await getBrief(db, ownerId, id);
  if (!brief) notFound();

  // opened_at transitions once (graduation-gate metric 1); the user_action rides
  // the same first-open guard so it's exactly-once too.
  const firstOpen = await markBriefOpened(db, ownerId, id);
  if (firstOpen) {
    await appendUserAction(db, { ownerId, action: "brief_opened", entityType: "brief", entityId: id });
  }

  const parsed = brief.kind === "morning" ? MorningBriefOutput.safeParse(brief.contentJson) : null;

  return (
    <article>
      <p>
        <small>
          {brief.kind} · {brief.dedupeKey} · generated {brief.generatedAt.toISOString()} ·{" "}
          <a href={`/briefs/${id}/debug`}>why did you say this?</a>
        </small>
      </p>
      {parsed?.success ? (
        <MorningBriefView content={parsed.data} />
      ) : (
        <div style={{ whiteSpace: "pre-wrap" }}>{brief.contentMd}</div>
      )}
    </article>
  );
}

function MorningBriefView({ content }: { content: import("@mission-control/core").MorningBriefOutputT }) {
  return (
    <div>
      <p style={{ fontSize: 18 }}>{content.headline}</p>
      {content.schedule.length > 0 && (
        <section>
          <h2>Today</h2>
          <ul>
            {content.schedule.map((s, i) => (
              <li key={i}>
                <strong>{s.time}</strong> {s.title}
                {s.prep_pointer ? <em> — {s.prep_pointer}</em> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      {content.top_commitments.length > 0 && (
        <section>
          <h2>Top commitments</h2>
          <ul>
            {content.top_commitments.map((c, i) => (
              <li key={i}>
                <a href="/commitments">{c.description}</a>
                {c.due_date ? ` (due ${c.due_date})` : ""}
                {c.why_now ? ` — ${c.why_now}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
      {content.waiting_on.length > 0 && (
        <section>
          <h2>Waiting on</h2>
          <ul>
            {content.waiting_on.map((w, i) => (
              <li key={i}>
                {w.description}
                {w.counterparty ? ` — ${w.counterparty}` : ""}
                <blockquote style={{ margin: "4px 0 4px 12px", color: "#555" }}>
                  draft: {w.nudge_draft}
                </blockquote>
              </li>
            ))}
          </ul>
        </section>
      )}
      {content.slipped.length > 0 && (
        <section>
          <h2>Slipped</h2>
          <ul>
            {content.slipped.map((s, i) => (
              <li key={i}>
                {s.description}
                {s.due_date ? ` (was due ${s.due_date})` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 10.4: Debug view.** Queries first (`apps/web/src/queries.ts`):

```ts
export async function getContextPacket(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(contextPackets)
    .where(and(eq(contextPackets.ownerId, ownerId), eq(contextPackets.id, id)));
  return row;
}

// "why did you say this?": packet commitments → source excerpt → source episode (MC-203)
export async function listCommitmentSources(db: Db, ownerId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select({
      id: commitments.id,
      description: commitments.description,
      sourceType: commitments.sourceType,
      sourceRef: commitments.sourceRef,
      sourceExcerpt: commitments.sourceExcerpt,
      episodeSummary: episodes.summary,
      episodeOccurredAt: episodes.occurredAt,
    })
    .from(commitments)
    .leftJoin(episodes, eq(commitments.sourceEpisodeId, episodes.id))
    .where(and(eq(commitments.ownerId, ownerId), inArray(commitments.id, ids)));
}
```

(add `commitments`, `contextPackets`, `episodes`, `inArray` to the imports.)

`apps/web/app/briefs/[id]/debug/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import type { MorningPacket } from "@mission-control/core";
import { getDb } from "../../../../src/db";
import { getBrief, getContextPacket, listCommitmentSources } from "../../../../src/queries";
import { requireOwnerId } from "../../../../src/session";

// MC-203 exit criterion 3: walk brief → packet → source rows.
export default async function BriefDebugPage({ params }: { params: Promise<{ id: string }> }) {
  const ownerId = await requireOwnerId();
  const { id } = await params;
  const db = getDb();
  const brief = await getBrief(db, ownerId, id);
  if (!brief) notFound();
  const packetRow = await getContextPacket(db, ownerId, brief.contextPacketId);
  const packet = packetRow?.content as MorningPacket | undefined;
  const sources = packet
    ? await listCommitmentSources(db, ownerId, packet.commitments.map((c) => c.id))
    : [];

  return (
    <div>
      <h1>Brief debug</h1>
      <p>
        <a href={`/briefs/${id}`}>← back to brief</a> · packet {brief.contextPacketId} · run{" "}
        {brief.cadenceRunId ? <a href={`/runs/${brief.cadenceRunId}`}>{brief.cadenceRunId}</a> : "—"}
      </p>

      <h2>Commitment sources</h2>
      {sources.length === 0 ? <p>No packet commitments.</p> : null}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr><th align="left">commitment</th><th align="left">source</th><th align="left">excerpt</th></tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id}>
              <td>{s.description}</td>
              <td><small>{s.sourceType}{s.episodeSummary ? ` · ${s.episodeSummary}` : ""}</small></td>
              <td><small>{s.sourceExcerpt ?? "—"}</small></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Context packet</h2>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "#f6f6f6", padding: 12 }}>
        {JSON.stringify(packet ?? packetRow?.content, null, 2)}
      </pre>
    </div>
  );
}
```

- [ ] **Step 10.5:** All web + core tests PASS; typecheck + lint. Commit: `feat(MC-203): structured reader, opened_at exactly-once + brief_opened action, debug view`

---

## MC-204 · Delivery hardening

### Task 11: Per-channel retry semantics in notify

**Files:**
- Modify: `apps/worker/src/jobs/notify.ts`
- Test: `apps/worker/src/jobs/notify.test.ts` (extend existing file, reuse its harness)

- [ ] **Step 11.1: Failing tests** — add to the existing describe:

```ts
// partial-failure matrix (MC-204):
// (a) email ok + push throws → run SUCCEEDS; steps: email ok, push failed;
//     emailedAt set, pushedAt null.  (may already exist — verify, add if missing)
// (b) email throws → run FAILS; emailedAt null; push never attempted.
// (c) per-channel retry: brief already has emailedAt set (simulate a retry after
//     email-success/push-fail) → email step status "skipped" with
//     detail.reason "already_emailed", email sender NOT called, push attempted.
// (d) both already delivered → both steps "skipped", senders not called, run succeeds.
```

- [ ] **Step 11.2:** Run → (c)/(d) FAIL. **Implement:** in `notify.ts`, wrap each channel:

```ts
// channel 1: email mirror (required) — skipped if a previous attempt delivered it,
// so a BullMQ retry after partial failure never double-sends (MC-204).
if (brief.emailedAt) {
  await appendRunStep(ctx.db, {
    runId, seq: 1, name: "email", status: "skipped",
    startedAt: new Date(), detail: { reason: "already_emailed" },
  });
} else {
  /* existing try/send/markBriefEmailed/append-ok block, unchanged */
}

// channel 2: web push (best-effort) — same skip guard.
let pushed = Boolean(brief.pushedAt);
if (brief.pushedAt) {
  await appendRunStep(ctx.db, {
    runId, seq: 2, name: "push", status: "skipped",
    startedAt: new Date(), detail: { reason: "already_pushed" },
  });
} else {
  /* existing try/catch push block, unchanged */
}

return { emailed: true, pushed, briefId };
```

- [ ] **Step 11.3:** PASS; commit: `feat(MC-204): per-channel delivery retry — skip already-delivered channels`

### Task 12: Push-health surface + daily cost ticker

**Files:**
- Modify: `apps/web/src/queries.ts` (`listPushSubscriptions`, `dailyModelSpendUsd`)
- Modify: `apps/web/app/settings/page.tsx` (push delivery health section)
- Modify: `apps/web/app/runs/page.tsx` (cost ticker)
- Test: `apps/web/src/delivery-health.test.ts`

- [ ] **Step 12.1: Failing tests:**

```ts
// 1. dailyModelSpendUsd sums only today's (Denver) model_calls: insert one row now
//    (cost 0.10) + one row createdAt now-48h (cost 5.00) → "0.10".
// 2. listPushSubscriptions returns rows with failureCount/disabledAt/lastSuccessAt.
// Direct query-level tests (no page rendering needed).
```

- [ ] **Step 12.2:** **Implement queries:**

```ts
export async function listPushSubscriptions(db: Db, ownerId: string) {
  return db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.ownerId, ownerId))
    .orderBy(desc(pushSubscriptions.createdAt));
}

// MC-204 cost ticker: today's spend, Denver day boundary.
export async function dailyModelSpendUsd(db: Db, ownerId: string): Promise<string> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)::numeric(12,2)`,
    })
    .from(modelCalls)
    .where(
      and(
        eq(modelCalls.ownerId, ownerId),
        sql`${modelCalls.createdAt} >= (date_trunc('day', now() at time zone 'America/Denver') at time zone 'America/Denver')`,
      ),
    );
  return row?.total ?? "0.00";
}
```

(add `modelCalls` + `sql` to imports.)

- [ ] **Step 12.3: Settings section** — in `settings/page.tsx` after PushSettings:

```tsx
const subs = await listPushSubscriptions(getDb(), ownerId);
// …
<h3>Push delivery health</h3>
{subs.length === 0 ? <p>No devices subscribed.</p> : (
  <table style={{ borderCollapse: "collapse", width: "100%" }}>
    <thead>
      <tr><th align="left">device</th><th align="left">status</th><th align="left">last success</th></tr>
    </thead>
    <tbody>
      {subs.map((s) => (
        <tr key={s.id} style={s.disabledAt ? { color: "crimson" } : undefined}>
          <td><small>{s.userAgent ?? s.endpoint.slice(0, 40)}</small></td>
          <td>
            {s.disabledAt
              ? `push broken since ${s.disabledAt.toISOString().slice(0, 10)} — re-enable on the device`
              : s.failureCount > 0
                ? `flaky (${s.failureCount} recent failures)`
                : "healthy"}
          </td>
          <td><small>{s.lastSuccessAt?.toISOString() ?? "never"}</small></td>
        </tr>
      ))}
    </tbody>
  </table>
)}
```

- [ ] **Step 12.4: Cost ticker** — in `runs/page.tsx`, fetch alongside the runs:

```tsx
import { getPreference } from "@mission-control/core";
// …
const spend = await dailyModelSpendUsd(db, ownerId);
const ceiling = (await getPreference<number>(db, ownerId, "daily_cost_ceiling_usd")) ?? 5;
const over = Number(spend) > ceiling;
// … right under <h1>Runs</h1>:
<p style={over ? { color: "crimson", fontWeight: 600 } : undefined}>
  Model spend today: ${spend} / ${ceiling.toFixed(2)} ceiling{over ? " — OVER" : ""}
</p>
```

- [ ] **Step 12.5:** PASS; typecheck + lint. Commit: `feat(MC-204): push delivery health in settings + daily cost ticker on /runs`

---

### Task 13: Env, docs, close-out, verification, merge

- [ ] **Step 13.1:** `.env.example` — under the LLM section add:

```
# Voyage embeddings (MC-201): used only by packages/llm embed()
VOYAGE_API_KEY=
```

`docs/DEPLOY.md` — add a short "Phase 2 env vars" note in the env section: `VOYAGE_API_KEY` required on **both** Railway services (web pins memories; worker assembles packets) before the first 7 AM run; without it the morning-brief run fails red on `/runs` (email/push of the brief will not go out).

- [ ] **Step 13.2:** `docs/INSIGHTS.md` — add Phase-2 entries for anything learned during the build (at minimum: packet determinism + truncation design, per-channel delivery semantics, anything discovered fighting the tools).
- [ ] **Step 13.3: Full verification** (from repo root):

```powershell
npm run typecheck; npm run lint; npm test
```

All green. (Tests need docker compose Postgres+Redis on 5433/6379 — `docker compose up -d` first.)

- [ ] **Step 13.4:** Commit docs: `docs(phase-2): VOYAGE_API_KEY, deploy notes, INSIGHTS close-out`
- [ ] **Step 13.5:** Merge + deploy:

```powershell
git checkout main
git merge --no-ff phase-2-morning-brief -m "Merge Phase 2 — Morning Brief (MC-201..MC-204)"
git push origin main
```

Watch CI (`gh run watch` or `gh run list`) — fix forward if red.

---

## Definition-of-done checklist (CLAUDE.md)

- Migrations: **none needed** (no schema changes; verify `npm run db:generate` produces no diff).
- Activity-log coverage (name in PR/summary): `cadence_runs` for `morning_brief` (+ `presync` run step), `notify` (per-channel steps incl. `skipped`); `model_calls` rows for `embed.memory`, `embed.query`, `cos.morning_brief`; `user_actions`: `memory_pinned`, `brief_opened`.
- Error visibility: generation-failure test proves failed run + no brief; presync-failure test proves failed step + stale flag.
- Eval: **not required** — extraction prompts/schemas untouched (and deliberately so; see hard constraints).
- INSIGHTS.md updated.
- Exit criteria needing Mark/production (report, don't block): 7 AM brief content sanity on the phone, push→reader→opened_at on iPhone, `VOYAGE_API_KEY` set in Railway.
