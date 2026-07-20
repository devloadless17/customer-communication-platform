import Anthropic from "@anthropic-ai/sdk";

import { aiGloballyEnabled, anthropicApiKey } from "./models";
import type { ChatJsonResult, ChatUsage } from "./openai-client";

/**
 * Thin facade over the official Anthropic SDK for the AI Assistant's TEXT brain.
 * Claude handles Lebanese/Arabizi dialect noticeably better than gpt-4o, so the
 * reply-text + spoken-script generation can route here while STT (OpenAI) and
 * voice synthesis (Azure/OpenAI) stay exactly where they are.
 *
 * Mirrors openai-client.ts's `chatJson` — same `ChatJsonResult<T>` return shape
 * — so reply-service.ts can dispatch between the two providers with no other
 * downstream change. Structured output uses a FORCED single tool call: the
 * reply JSON schema is the tool's `input_schema` and `tool_choice` pins it, so
 * the model must emit exactly that object (the strict-schema analogue of
 * OpenAI's response_format json_schema).
 *
 * The SDK is a direct dependency (already imported statically for the composer
 * Translate feature), so no guarded dynamic import is needed here — a missing
 * key is handled by `anthropicConfigured()` at the call site.
 */

let client: Anthropic | null = null;

function getClient(): Anthropic {
  const key = anthropicApiKey();
  if (!key) throw new Error("missing_ANTHROPIC_API_KEY");
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

/** True when the assistant is enabled AND an Anthropic key is present. */
export function anthropicConfigured(): boolean {
  return aiGloballyEnabled() && !!anthropicApiKey();
}

/**
 * Structured generation constrained to a JSON schema via a forced tool call.
 * Returns parsed `data` (null if no tool block came back) plus raw content +
 * usage, matching openai-client.ts's `chatJson` contract.
 */
export async function chatJsonAnthropic<T>(opts: {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<ChatJsonResult<T>> {
  const anthropic = getClient();
  const res = await anthropic.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1200,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    tools: [
      {
        name: opts.schemaName,
        description: "Return the structured customer reply as this tool's input.",
        input_schema: opts.schema as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: opts.schemaName },
  });

  const block = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  const data = (block?.input as T | undefined) ?? null;
  const rawContent = block ? JSON.stringify(block.input) : "";

  const usage: ChatUsage = {
    prompt_tokens: res.usage.input_tokens,
    completion_tokens: res.usage.output_tokens,
    prompt_tokens_details: {
      cached_tokens: res.usage.cache_read_input_tokens ?? undefined,
    },
  };

  return { data, rawContent, model: res.model, usage };
}
