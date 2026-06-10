import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  briefs,
  contextPackets,
  userActions,
  users,
  type Db,
  createDb,
} from "@mission-control/db";

const cookieJar = new Map<string, string>();
import { vi } from "vitest";
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

const OWNER_EMAIL = "web-brief-reader-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef-xyz";
  process.env.SESSION_PASSWORD = "reader secret";
  process.env.USER_EMAIL = OWNER_EMAIL;
  ({ db } = createDb(
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control",
  ));
  await db.insert(users).values({ email: OWNER_EMAIL, displayName: "Brief Reader Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

afterAll(async () => {
  // Nothing queue-related to close for this test file
});

beforeEach(async () => {
  cookieJar.clear();
  // FK order: briefs before contextPackets
  await db.delete(userActions).where(eq(userActions.ownerId, ownerId));
  await db.delete(briefs).where(eq(briefs.ownerId, ownerId));
  await db.delete(contextPackets).where(eq(contextPackets.ownerId, ownerId));
});

async function login() {
  const { POST } = await import("../app/api/login/route");
  const form = new FormData();
  form.set("secret", "reader secret");
  await POST(new Request("http://localhost:3000/api/login", { method: "POST", body: form }));
}

async function seedBrief() {
  const [packet] = await db
    .insert(contextPackets)
    .values({ ownerId, task: "cos.morning_brief", content: {} })
    .returning({ id: contextPackets.id });
  const [brief] = await db
    .insert(briefs)
    .values({
      ownerId,
      kind: "morning",
      dedupeKey: `morning:reader-test-${Date.now()}`,
      contentJson: {},
      contentMd: "Hello brief",
      contextPacketId: packet!.id,
    })
    .returning({ id: briefs.id });
  return brief!.id;
}

describe("BriefReaderPage", () => {
  it("rendering sets opened_at and writes exactly one brief_opened user_action", async () => {
    await login();
    const briefId = await seedBrief();
    const { default: Page } = await import("../app/briefs/[id]/page");
    await Page({ params: Promise.resolve({ id: briefId }) });

    const [row] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(row!.openedAt).not.toBeNull();

    const actions = await db
      .select()
      .from(userActions)
      .where(eq(userActions.ownerId, ownerId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: "brief_opened", entityType: "brief", entityId: briefId });
  });

  it("rendering again leaves opened_at unchanged and writes no second user_action", async () => {
    await login();
    const briefId = await seedBrief();
    const { default: Page } = await import("../app/briefs/[id]/page");

    // First render
    await Page({ params: Promise.resolve({ id: briefId }) });
    const [rowAfterFirst] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    const firstOpenedAt = rowAfterFirst!.openedAt;

    // Small delay to ensure timestamp would differ if it were re-written
    await new Promise((r) => setTimeout(r, 5));

    // Second render
    await Page({ params: Promise.resolve({ id: briefId }) });
    const [rowAfterSecond] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(rowAfterSecond!.openedAt?.getTime()).toBe(firstOpenedAt?.getTime());

    const actions = await db
      .select()
      .from(userActions)
      .where(eq(userActions.ownerId, ownerId));
    expect(actions).toHaveLength(1);
  });

  it("unauthenticated: requireOwnerId redirects (throws NEXT_REDIRECT)", async () => {
    // cookieJar is cleared in beforeEach — no login() call here
    const briefId = await seedBrief();
    const { default: Page } = await import("../app/briefs/[id]/page");
    await expect(Page({ params: Promise.resolve({ id: briefId }) })).rejects.toThrow("NEXT_REDIRECT");
  });
});
