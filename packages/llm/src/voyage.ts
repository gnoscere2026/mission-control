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
