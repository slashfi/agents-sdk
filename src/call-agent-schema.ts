/**
 * Shared JSON Schema for the `call_agent` MCP tool.
 *
 * Single source of truth — used by:
 * - `getToolDefinitions()` in server.ts (tools/list)
 * - Type definitions in types.ts (CallAgentRequest)
 *
 * When adding a new field to call_agent, update it HERE.
 * The handler in server.ts and the types in types.ts must also be updated,
 * but THIS file is the canonical schema for what the LLM sees.
 */

// ---------------------------------------------------------------------------
// JSON Schema for `call_agent` tool input
// ---------------------------------------------------------------------------

/**
 * All actions supported by the call_agent handler.
 * Keep in sync with the switch cases in registry.ts `call()`.
 */
export const CALL_AGENT_ACTIONS = [
  "execute_tool",
  "describe_tools",
  "load",
  "invoke",
  "ask",
  "learn",
] as const;

/**
 * The MCP input schema for the `call_agent` tool.
 * This is what the LLM sees via `tools/list`.
 */
export const callAgentInputSchema = {
  type: "object" as const,
  properties: {
    request: {
      type: "object" as const,
      description: "The call request",
      properties: {
        action: {
          type: "string" as const,
          enum: [...CALL_AGENT_ACTIONS],
          description: "Action to perform",
        },
        path: {
          type: "string" as const,
          description: "Agent path (e.g., '@my-agent')",
        },
        tool: {
          type: "string" as const,
          description: "Tool name to call",
        },
        params: {
          type: "object" as const,
          description: "Parameters for the tool",
          additionalProperties: true,
        },
        prompt: {
          type: "string" as const,
          description: "Prompt text (for invoke/ask actions)",
        },
      },
      required: ["action", "path"] as const,
    },
  },
  required: ["request"] as const,
};
