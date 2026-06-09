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
