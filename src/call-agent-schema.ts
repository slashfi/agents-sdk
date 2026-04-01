/**
 * Zod schemas for the `call_agent` MCP tool.
 *
 * SINGLE SOURCE OF TRUTH for:
 * - Request TypeScript types (via z.infer)
 * - JSON Schema for MCP tool definitions (via callAgentInputSchema)
 * - Runtime validation
 *
 * When adding a new action or field, update it HERE.
 * Types and JSON schemas are derived automatically.
 *
 * Response types live in types.ts (they're output shapes, not validated input).
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Base schemas
// ─────────────────────────────────────────────────────────────────────────────

export const callerTypeSchema = z.enum(["agent", "user", "system"]);

const callAgentBaseSchema = z.object({
  path: z.string().describe("Agent path (e.g., '@my-agent')"),
  callerId: z.string().optional().describe("Caller ID for access control"),
  callerType: callerTypeSchema.optional().describe("Caller type"),
  metadata: z.record(z.unknown()).optional().describe("Additional metadata"),
});

// ─────────────────────────────────────────────────────────────────────────────
// Action schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Invoke: fire-and-forget */
export const invokeActionSchema = callAgentBaseSchema.extend({
  action: z.literal("invoke"),
  prompt: z.string().describe("Prompt text (for invoke/ask actions)"),
  sessionId: z
    .string()
    .optional()
    .describe("Session ID for continuity (omit for new session)"),
  branchAttributes: z
    .record(z.string())
    .optional()
    .describe("Key-value attributes to set on the new branch"),
});

/** Ask: invoke and wait for response */
export const askActionSchema = callAgentBaseSchema.extend({
  action: z.literal("ask"),
  prompt: z.string().describe("Prompt text (for invoke/ask actions)"),
  sessionId: z
    .string()
    .optional()
    .describe("Session ID for continuity (omit for new session)"),
  branchAttributes: z
    .record(z.string())
    .optional()
    .describe("Key-value attributes to set on the new branch"),
});

/** Execute a specific tool */
export const executeToolActionSchema = callAgentBaseSchema.extend({
  action: z.literal("execute_tool"),
  tool: z.string().describe("Tool name to call"),
  params: z
    .record(z.unknown())
    .optional()
    .describe("Parameters for the tool"),
});

/** Get tool schemas for an agent */
export const describeToolsActionSchema = callAgentBaseSchema.extend({
  action: z.literal("describe_tools"),
  tools: z
    .array(z.string())
    .optional()
    .describe("Optional: filter to specific tool names. Omit to list all."),
});

/** Load: get agent definition */
export const loadActionSchema = callAgentBaseSchema.extend({
  action: z.literal("load"),
});

// ─────────────────────────────────────────────────────────────────────────────
// Discriminated union (source of truth)
// ─────────────────────────────────────────────────────────────────────────────

export const callAgentRequestSchema = z.discriminatedUnion("action", [
  invokeActionSchema,
  askActionSchema,
  executeToolActionSchema,
  describeToolsActionSchema,
  loadActionSchema,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Derived types (DO NOT hand-write — these come from zod)
// ─────────────────────────────────────────────────────────────────────────────

export type CallAgentRequest = z.infer<typeof callAgentRequestSchema>;
export type CallAgentInvokeRequest = z.infer<typeof invokeActionSchema>;
export type CallAgentAskRequest = z.infer<typeof askActionSchema>;
export type CallAgentExecuteToolRequest = z.infer<
  typeof executeToolActionSchema
>;
export type CallAgentDescribeToolsRequest = z.infer<
  typeof describeToolsActionSchema
>;
export type CallAgentLoadRequest = z.infer<typeof loadActionSchema>;

/** All supported agent actions — derived from the schema. */
export type AgentAction = CallAgentRequest["action"];

/** CallerType — derived from the schema. */
export type CallerType = z.infer<typeof callerTypeSchema>;

/** All supported action strings as a const array. */
export const CALL_AGENT_ACTIONS: AgentAction[] =
  callAgentRequestSchema.options.map(
    (s) => (s.shape as { action: z.ZodLiteral<AgentAction> }).action.value
  );

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema for MCP (flat, for LLM tool definitions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The MCP input schema for the `call_agent` tool.
 * This is what the LLM sees via `tools/list`.
 *
 * MCP uses flat JSON Schema (no discriminated unions), so we flatten
 * the zod schemas into a single object with all optional fields
 * plus the required `action` and `path`.
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
        tools: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Tool names to describe (for describe_tools). Omit to list all.",
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
        sessionId: {
          type: "string" as const,
          description: "Session ID for continuity (omit for new session)",
        },
        branchAttributes: {
          type: "object" as const,
          description: "Key-value attributes to set on the new branch",
          additionalProperties: { type: "string" as const },
        },
      },
      required: ["action", "path"] as const,
    },
  },
  required: ["request"] as const,
};
