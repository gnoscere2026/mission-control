import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import {
  commitments,
  createDb,
  episodes,
  userActions,
  users,
  type Db,
} from "@mission-control/db";
import { closeQueuesForTesting, getQueue } from "./queues";

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

const OWNER_EMAIL = "web-capture-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef-xyz";
  process.env.SESSION_PASSWORD = "capture secret";
  process.env.USER_EMAIL = OWNER_EMAIL;
  ({ db } = createDb(
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control",
  ));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Capture Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

afterAll(async () => {
  await closeQueuesForTesting();
});

beforeEach(async () => {
  cookieJar.clear();
  await db.delete(commitments).where(eq(commitments.ownerId, ownerId));
  await db.delete(userActions).where(eq(userActions.ownerId, ownerId));
  await db.delete(episodes).where(eq(episodes.ownerId, ownerId));
});

async function login() {
  const { POST } = await import("../app/api/login/route");
  const form = new FormData();
  form.set("secret", "capture secret");
  await POST(new Request("http://localhost:3000/api/login", { method: "POST", body: form }));
}

function captureReq(text: string): Request {
  return new Request("http://localhost:3000/api/capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

describe("POST /api/capture", () => {
  it("401 without a session", async () => {
    const { POST } = await import("../app/api/capture/route");
    expect((await POST(captureReq("hello"))).status).toBe(401);
  });

  it("writes episode + user_action and enqueues the standard extraction job", async () => {
    await login();
    const { POST } = await import("../app/api/capture/route");
    const res = await POST(captureReq("told Sara I'd send the contract Friday"));
    expect(res.status).toBe(200);
    const { episodeId } = (await res.json()) as { episodeId: string };

    const [ep] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(ep).toMatchObject({ ownerId, source: "chat", type: "chat_message" });
    expect((ep!.payload as { text: string }).text).toBe("told Sara I'd send the contract Friday");

    const [action] = await db
      .select()
      .from(userActions)
      .where(eq(userActions.ownerId, ownerId))
      .orderBy(desc(userActions.createdAt))
      .limit(1);
    expect(action).toMatchObject({ action: "capture_submitted", entityId: episodeId });

    // the job is on the extraction queue with the deterministic id
    const job = await getQueue("extraction").getJob(`extract-episode-${episodeId}`);
    expect(job).toBeTruthy();
    expect(job!.data).toEqual({ episodeId });
    await job!.remove();
  });

  it("rejects empty text", async () => {
    await login();
    const { POST } = await import("../app/api/capture/route");
    expect((await POST(captureReq("   "))).status).toBe(400);
  });
});

describe("GET /api/capture/feed", () => {
  it("401 without a session", async () => {
    const { GET } = await import("../app/api/capture/feed/route");
    expect((await GET()).status).toBe(401);
  });

  it("returns the thread with candidates attached to their message", async () => {
    await login();
    const [ep] = await db
      .insert(episodes)
      .values({
        ownerId,
        occurredAt: new Date(),
        type: "chat_message",
        source: "chat",
        summary: "told Sara…",
        payload: { text: "told Sara I'd send the contract Friday" },
      })
      .returning({ id: episodes.id });
    await db.insert(commitments).values({
      ownerId,
      direction: "owed_by_me",
      description: "send Sara the contract",
      sourceType: "chat",
      sourceEpisodeId: ep!.id,
      status: "candidate",
      confidence: 0.9,
    });

    const { GET } = await import("../app/api/capture/feed/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      messages: { id: string; text: string }[];
      candidates: { episodeId: string; description: string; status: string }[];
    };
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]!.text).toContain("told Sara");
    expect(data.candidates).toHaveLength(1);
    expect(data.candidates[0]!).toMatchObject({
      episodeId: ep!.id,
      description: "send Sara the contract",
      status: "candidate",
    });
  });
});
