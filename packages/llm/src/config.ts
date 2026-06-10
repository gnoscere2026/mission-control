// Tier → model mapping and the in-repo price table (ARCHITECTURE §2.7).
// Models are referenced by tier everywhere else in the repo; swapping a tier is
// a change here plus an eval run, never a code change.

export type Tier = "cheap" | "mid" | "top" | "embed";

export const TIER_MODELS: Record<Exclude<Tier, "embed">, { provider: "anthropic"; model: string }> =
  {
    cheap: { provider: "anthropic", model: "claude-haiku-4-5" },
    mid: { provider: "anthropic", model: "claude-sonnet-4-6" }, // reserved: cos.chat (Phase 4)
    top: { provider: "anthropic", model: "claude-opus-4-8" },
  };

// USD per MTok. Cache reads bill at 0.1× input (Anthropic).
export const MODEL_PRICES: Record<
  string,
  { inPerMTok: number; outPerMTok: number; cacheReadPerMTok: number }
> = {
  "claude-haiku-4-5": { inPerMTok: 1, outPerMTok: 5, cacheReadPerMTok: 0.1 },
  "claude-sonnet-4-6": { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3 },
  "claude-opus-4-8": { inPerMTok: 5, outPerMTok: 25, cacheReadPerMTok: 0.5 },
  "voyage-3.5": { inPerMTok: 0.06, outPerMTok: 0, cacheReadPerMTok: 0 },
};

// Persona-namespaced task registry (ARCHITECTURE §1.1). Unknown tasks throw:
// a task must be consciously registered with a tier, never defaulted.
export const TASK_TIERS: Record<string, Exclude<Tier, "embed">> = {
  "cos.extract_commitments": "cheap",
  "cos.morning_brief": "top",
  "eval.match_judge": "cheap",
};

export interface ResolvedTask {
  tier: Exclude<Tier, "embed">;
  provider: "anthropic";
  model: string;
}

export function resolveTask(task: string): ResolvedTask {
  const tier = TASK_TIERS[task];
  if (!tier) throw new Error(`unknown LLM task "${task}" — register it in packages/llm config`);
  const { provider, model } = TIER_MODELS[tier];
  return { tier, provider, model };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

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

// numeric(10,6) string for the model_calls.cost_usd column.
export function computeCostUsd(model: string, usage: Usage): string {
  const price = MODEL_PRICES[model];
  if (!price) throw new Error(`model "${model}" missing from the price table`);
  const usd =
    (usage.inputTokens / 1e6) * price.inPerMTok +
    (usage.outputTokens / 1e6) * price.outPerMTok +
    (usage.cacheReadTokens / 1e6) * price.cacheReadPerMTok;
  return usd.toFixed(6);
}
