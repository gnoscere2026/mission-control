import { z } from "zod";
import { modelCalls, type Db } from "@mission-control/db";
import { computeCostUsd, resolveTask, type Usage } from "./config";
import { createAnthropicAdapter } from "./anthropic";
import type { ProviderAdapter } from "./types";

export class LlmSchemaError extends Error {}

export interface CompleteArgs<T> {
  db: Db;
  ownerId: string;
  task: string; // persona-namespaced, e.g. "cos.extract_commitments"
  schema: z.ZodType<T>;
  system?: string;
  prompt: string;
  toolName?: string;
  toolDescription?: string;
  maxTokens?: number;
  runId?: string | null;
  promptVersion?: string;
  dataCategories: string[]; // email | calendar | memory | commitment | capture
  agentKey?: string;
  adapter?: ProviderAdapter; // injectable for tests
}

export interface CompleteResult<T> {
  data: T;
  modelCallId: string;
  costUsd: string;
  latencyMs: number;
}

const DEFAULT_MAX_TOKENS = 4096;

// The single model-call entry point (invariant 3): tier routing, Zod→JSON-Schema
// forced tool-use, exactly one schema-feedback retry, and the cost-tracked
// model_calls row — written here and nowhere else, success or failure.
export async function complete<T>(args: CompleteArgs<T>): Promise<CompleteResult<T>> {
  const { tier, provider, model } = resolveTask(args.task);
  const adapter = args.adapter ?? createAnthropicAdapter();
  const toolName = args.toolName ?? "emit_result";
  const toolDescription =
    args.toolDescription ?? "Emit the structured result. Always call this tool exactly once.";
  const jsonSchema = z.toJSONSchema(args.schema) as Record<string, unknown>;

  const started = Date.now();
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  async function writeRow(status: "ok" | "schema_retry_ok" | "failed", error?: string) {
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
        promptVersion: args.promptVersion,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUsd: computeCostUsd(model, usage),
        latencyMs: Date.now() - started,
        dataCategories: args.dataCategories,
        status,
        error,
      })
      .returning({ id: modelCalls.id, costUsd: modelCalls.costUsd });
    if (!row) throw new Error("model_calls insert returned no row");
    return row;
  }

  async function attempt(prompt: string) {
    const res = await adapter.completeStructured({
      model,
      system: args.system,
      prompt,
      toolName,
      toolDescription,
      jsonSchema,
      maxTokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.cacheReadTokens += res.usage.cacheReadTokens;
    return args.schema.safeParse(res.toolInput);
  }

  try {
    const first = await attempt(args.prompt);
    if (first.success) {
      const row = await writeRow("ok");
      return {
        data: first.data,
        modelCallId: row.id,
        costUsd: row.costUsd,
        latencyMs: Date.now() - started,
      };
    }

    // exactly one schema-feedback retry (ARCHITECTURE §2.6)
    const issues = JSON.stringify(first.error.issues);
    const second = await attempt(
      `${args.prompt}\n\nYour previous output failed schema validation with these errors:\n${issues}\nCall the ${toolName} tool again with corrected output.`,
    );
    if (second.success) {
      const row = await writeRow("schema_retry_ok");
      return {
        data: second.data,
        modelCallId: row.id,
        costUsd: row.costUsd,
        latencyMs: Date.now() - started,
      };
    }

    const message = `schema validation failed after retry: ${JSON.stringify(second.error.issues).slice(0, 2000)}`;
    await writeRow("failed", message);
    throw new LlmSchemaError(message);
  } catch (err) {
    if (err instanceof LlmSchemaError) throw err;
    // provider/transport failure: record it, then let the job layer retry
    await writeRow("failed", err instanceof Error ? err.message : String(err));
    throw err;
  }
}
