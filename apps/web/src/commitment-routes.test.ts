import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Ownerless access impossible (MC-105 test requirement): every disposition
// route rejects a session-less request before touching the DB.
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

const params = { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) };
const jsonReq = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("disposition routes reject unauthenticated requests", () => {
  it("confirm → 401", async () => {
    const { POST } = await import("../app/api/commitments/[id]/confirm/route");
    expect((await POST(new Request("http://x/c", { method: "POST" }), params)).status).toBe(401);
  });
  it("reject → 401", async () => {
    const { POST } = await import("../app/api/commitments/[id]/reject/route");
    expect((await POST(new Request("http://x/r", { method: "POST" }), params)).status).toBe(401);
  });
  it("edit → 401", async () => {
    const { POST } = await import("../app/api/commitments/[id]/edit/route");
    expect((await POST(jsonReq("http://x/e", { description: "x" }), params)).status).toBe(401);
  });
  it("snooze → 401", async () => {
    const { POST } = await import("../app/api/commitments/[id]/snooze/route");
    expect((await POST(jsonReq("http://x/s", { days: 7 }), params)).status).toBe(401);
  });
  it("manual add → 401", async () => {
    const { POST } = await import("../app/api/commitments/route");
    const form = new FormData();
    form.set("description", "x");
    form.set("direction", "owed_by_me");
    expect(
      (await POST(new Request("http://x/m", { method: "POST", body: form }))).status,
    ).toBe(401);
  });
});
