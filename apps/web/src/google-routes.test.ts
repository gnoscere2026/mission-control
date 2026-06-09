import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Ownerless access impossible (invariant 1): every /api/google/* handler must
// reject a request with no session before doing anything else.
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

beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef-xyz";
});

beforeEach(() => cookieJar.clear());

describe("google routes reject unauthenticated requests", () => {
  it("GET /api/google/connect → 401", async () => {
    const { GET } = await import("../app/api/google/connect/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("GET /api/google/callback → 401", async () => {
    const { GET } = await import("../app/api/google/callback/route");
    const res = await GET(new Request("http://localhost:3000/api/google/callback?code=x&state=y"));
    expect(res.status).toBe(401);
  });

  it("POST /api/google/disconnect → 401", async () => {
    const { POST } = await import("../app/api/google/disconnect/route");
    const form = new FormData();
    form.set("accountId", "00000000-0000-0000-0000-000000000000");
    const res = await POST(
      new Request("http://localhost:3000/api/google/disconnect", { method: "POST", body: form }),
    );
    expect(res.status).toBe(401);
  });
});
