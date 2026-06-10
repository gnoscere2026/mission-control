import type { Usage } from "./config";

// The provider seam: adapters implement exactly this. Tests inject fakes here;
// production resolves the adapter from the task's provider.
export interface StructuredCallArgs {
  model: string;
  system?: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
}

export interface StructuredCallResult {
  toolInput: unknown;
  usage: Usage;
}

export interface ProviderAdapter {
  completeStructured(args: StructuredCallArgs): Promise<StructuredCallResult>;
}

// Embedding seam (MC-201): mirrors ProviderAdapter for embed().
export interface EmbedBatchArgs {
  model: string;
  input: string[];
  inputType?: "document" | "query";
}

export interface EmbedBatchResult {
  embeddings: number[][];
  usage: { totalTokens: number };
}

export interface EmbeddingAdapter {
  embedBatch(args: EmbedBatchArgs): Promise<EmbedBatchResult>;
}
