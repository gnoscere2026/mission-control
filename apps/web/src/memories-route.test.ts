import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import {
  createDb,
  memories,
  modelCalls,
  userActions,
  users,
  type Db,
} from "@mission-control/db";

// vi.mock hoisted before other imports per vitest hoisting rules
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

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
    set: (name: string | { name: string; value: string }, value?: string) => {
      if (typeof name === "object") cookieJar.set(name.name, name.value);
      else cookieJar.set(name, value ?? "");
    },
    delete: (name: string) => cookieJar.delete(name),
  }),
}));

const OWNER_EMAIL = "web-memories-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef-xyz";
  process.env.SESSION_PASSWORD = "memories secret";
  process.env.USER_EMAIL = OWNER_EMAIL;
  ({ db } = createDb(
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control",
  ));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Memories Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

afterAll(async () => {
  // nothing to close (no queues used)
});

beforeEach(async () => {
  cookieJar.clear();
  await db.delete(memories).where(eq(memories.ownerId, ownerId));
  await db.delete(userActions).where(eq(userActions.ownerId, ownerId));
  await db.delete(modelCalls).where(eq(modelCalls.ownerId, ownerId));
});

async function login() {
  const { POST } = await import("../app/api/login/route");
  const form = new FormData();
  form.set("secret", "memories secret");
  await POST(new Request("http://localhost:3000/api/login", { method: "POST", body: form }));
}

function memoriesReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/memories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/memories", () => {
  it("401 without a session", async () => {
    const { POST } = await import("../app/api/memories/route");
    const res = await POST(memoriesReq({ content: "some content" }));
    expect(res.status).toBe(401);
  });

  it("pins content → memory row + memory_pinned user action", async () => {
    await login();
    const { POST } = await import("../app/api/memories/route");
    const res = await POST(memoriesReq({ content: "Prefers async updates over meetings" }));
    expect(res.status).toBe(200);
    const { memoryId } = (await res.json()) as { memoryId: string };
    expect(memoryId).toBeTruthy();

    const [mem] = await db.select().from(memories).where(eq(memories.id, memoryId));
    expect(mem).toMatchObject({
      ownerId,
      source: "manual_pin",
      pinned: true,
      content: "Prefers async updates over meetings",
    });

    const [action] = await db
      .select()
      .from(userActions)
      .where(eq(userActions.ownerId, ownerId))
      .orderBy(desc(userActions.createdAt))
      .limit(1);
    expect(action).toMatchObject({
      action: "memory_pinned",
      entityId: memoryId,
    });
  });

  it("rejects empty content", async () => {
    await login();
    const { POST } = await import("../app/api/memories/route");
    const res = await POST(memoriesReq({ content: "  " }));
    expect(res.status).toBe(400);
  });
});
