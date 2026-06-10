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
