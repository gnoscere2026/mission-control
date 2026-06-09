import Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter, StructuredCallArgs, StructuredCallResult } from "./types";

// The ONLY provider-SDK import in the repo (CLAUDE.md invariant 3; enforced by
// the no-restricted-imports lint rule).

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic();
  }
  return client;
}

export function createAnthropicAdapter(): ProviderAdapter {
  return {
    async completeStructured(args: StructuredCallArgs): Promise<StructuredCallResult> {
      const res = await getClient().messages.create({
        model: args.model,
        max_tokens: args.maxTokens,
        ...(args.system ? { system: args.system } : {}),
        messages: [{ role: "user", content: args.prompt }],
        tools: [
          {
            name: args.toolName,
            description: args.toolDescription,
            input_schema: args.jsonSchema as Anthropic.Tool["input_schema"],
            // structured outputs: constrain decoding to the schema where supported
            strict: true,
          } as Anthropic.Tool,
        ],
        tool_choice: { type: "tool", name: args.toolName },
      });

      const toolUse = res.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === args.toolName,
      );
      if (!toolUse) {
        throw new Error(`anthropic response contained no ${args.toolName} tool_use block`);
      }
      return {
        toolInput: toolUse.input,
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}
