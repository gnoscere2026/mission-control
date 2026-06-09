import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, users } from "@mission-control/db";

// In-memory stand-in for Next's request-scoped cookie store, so the route
// handler (and iron-session under it) can run inside vitest.
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

const TEST_EMAIL = "web-login-test@example.com";

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef-xyz";
  process.env.SESSION_PASSWORD = "open sesame";
  process.env.USER_EMAIL = TEST_EMAIL;
  const { db, pool } = createDb(
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control",
  );
  await db.insert(users).values({ email: TEST_EMAIL, displayName: "Web Test" }).onConflictDoNothing();
  await pool.end();
});

beforeEach(() => cookieJar.clear());

function loginRequest(secret: string): Request {
  const form = new FormData();
  form.set("secret", secret);
  return new Request("http://localhost:3000/api/login", { method: "POST", body: form });
}

describe("POST /api/login", () => {
  it("wrong secret → 401 and no session cookie", async () => {
    const { POST } = await import("./route");
    const res = await POST(loginRequest("not the secret"));
    expect(res.status).toBe(401);
    expect(cookieJar.has("mc_session")).toBe(false);
  });

  it("right secret → redirect with sealed session cookie", async () => {
    const { POST } = await import("./route");
    const res = await POST(loginRequest("open sesame"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    expect(cookieJar.get("mc_session")).toBeTruthy();
    // sealed, not plaintext: the cookie must not contain the owner id verbatim
    expect(cookieJar.get("mc_session")).not.toContain(TEST_EMAIL);
  });
});
