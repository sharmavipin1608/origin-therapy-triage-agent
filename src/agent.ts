import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  withItemContext,
  getToolCallsForItem,
  search_patient,
  verify_insurance,
  lookup_policy,
  find_slots,
  hold_slot,
  create_task,
  draft_message,
  escalate,
} from "./tools.js";
import type { InboxItem, ItemOutput } from "./types.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { TOOLS } from "./tools-schema.js";
import {
  validateLlmOutput,
  applySafetyGuard,
  fallbackOutput,
} from "./llm-output-validator.js";

// Cache the system prompt across all loop iterations — first call caches it,
// subsequent calls within the same item reuse it at ~90% reduced input token cost.
const CACHED_SYSTEM: Anthropic.TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

// ─── Tool dispatch ────────────────────────────────────────────────────────────

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "search_patient":
      return search_patient(args as Parameters<typeof search_patient>[0]);
    case "verify_insurance":
      return verify_insurance(args as Parameters<typeof verify_insurance>[0]);
    case "lookup_policy":
      return lookup_policy(args as Parameters<typeof lookup_policy>[0]);
    case "find_slots":
      return find_slots(args as Parameters<typeof find_slots>[0]);
    case "hold_slot":
      return hold_slot(args as Parameters<typeof hold_slot>[0]);
    case "create_task":
      return create_task(args as Parameters<typeof create_task>[0]);
    case "draft_message":
      return draft_message(args as Parameters<typeof draft_message>[0]);
    case "escalate":
      return escalate(args as Parameters<typeof escalate>[0]);
    default:
      throw new Error(`Unknown tool requested by model: "${name}". Possible model drift.`);
  }
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

async function processItem(
  item: InboxItem,
  client: Anthropic,
): Promise<ItemOutput> {
  try {
    return await withItemContext(item.id, async () => {
      const collectedTaskIds: string[] = [];

      const messages: Anthropic.MessageParam[] = [
        {
          role: "user",
          content: `Process this inbox item and triage it:\n\n${JSON.stringify(item, null, 2)}`,
        },
      ];

      let response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: CACHED_SYSTEM,
        tools: TOOLS,
        messages,
      });

      // Agentic loop — run until Claude stops requesting tool calls
      const MAX_ITERATIONS = 15;
      let iterations = 0;

      while (response.stop_reason === "tool_use") {
        if (++iterations > MAX_ITERATIONS) {
          throw new Error(
            `Exceeded max tool call iterations (${MAX_ITERATIONS}) for item ${item.id}`,
          );
        }
        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        );

        messages.push({ role: "assistant", content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUseBlocks) {
          const result = await dispatchTool(
            toolUse.name,
            toolUse.input as Record<string, unknown>,
          );

          if (
            toolUse.name === "create_task" &&
            result !== null &&
            typeof result === "object" &&
            "data" in result
          ) {
            const data = (result as { data: { task_id?: string } }).data;
            if (typeof data.task_id === "string") {
              collectedTaskIds.push(data.task_id);
            }
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        }

        messages.push({ role: "user", content: toolResults });

        response = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: CACHED_SYSTEM,
          tools: TOOLS,
          messages,
        });
      }

      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === "text",
      );

      if (!textBlock) {
        throw new Error(`No text response for item ${item.id}`);
      }

      const validated = applySafetyGuard(validateLlmOutput(textBlock.text, item.id));
      const toolsCalled = getToolCallsForItem(item.id);

      return {
        item_id: item.id,
        ...validated,
        tools_called: toolsCalled,
        requires_human_review: true,
        task_ids: collectedTaskIds,
      };
    });
  } catch (error) {
    // Catastrophic failure: return a valid fallback so the batch still completes
    const toolsCalled = getToolCallsForItem(item.id);
    return {
      item_id: item.id,
      ...fallbackOutput(item.id, error instanceof Error ? error.message : String(error)),
      tools_called: toolsCalled,
      requires_human_review: true,
      task_ids: [],
    };
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const client = new Anthropic();
  return Promise.all(inbox.map((item) => processItem(item, client)));
}
