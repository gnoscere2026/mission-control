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
