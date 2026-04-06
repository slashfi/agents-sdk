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

/** List resources: discover available resources on an agent */
export const listResourcesActionSchema = callAgentBaseSchema.extend({
  action: z.literal("list_resources").describe("List all resources available on an agent — docs, auth instructions, config schemas, etc."),
});

/** Read resources: fetch one or more resources by URI */
export const readResourcesActionSchema = callAgentBaseSchema.extend({
  action: z.literal("read_resources").describe("Fetch one or more resources by URI. Use list_resources first to discover available URIs."),
  uris: z
    .array(z.string())
    .describe("Resource URIs to read (e.g., ['AUTH.md'])"),
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
  listResourcesActionSchema,
  readResourcesActionSchema,
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
export type CallAgentListResourcesRequest = z.infer<
  typeof listResourcesActionSchema
>;
export type CallAgentReadResourcesRequest = z.infer<
  typeof readResourcesActionSchema
>;

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
// JSON Schema for MCP (derived from zod)
// ─────────────────────────────────────────────────────────────────────────────

import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Zod schema for the full MCP tool input (wraps request in an outer object).
 * This is the schema that gets converted to JSON Schema for the LLM.
 */
export const callAgentToolInputSchema = z.object({
  request: callAgentRequestSchema.describe("The call request"),
});

/**
 * The MCP input schema for the `call_agent` tool.
 * This is what the LLM sees via `tools/list`.
 *
 * Fully derived from the zod schemas — no hand-written JSON Schema.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const callAgentInputSchema = zodToJsonSchema(
  callAgentToolInputSchema as any,
  { target: "openAi" }
);

// ─────────────────────────────────────────────────────────────────────────────
// list_agents schema
// ─────────────────────────────────────────────────────────────────────────────

export const listAgentsToolInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Search query. When provided, returns agents ranked by BM25 relevance over paths, names, descriptions, and tool names.",
    ),
  limit: z
    .number()
    .optional()
    .describe(
      "Maximum number of results per page (default: 20)",
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "Pagination cursor from a previous response's nextCursor field.",
    ),
});

export type ListAgentsInput = z.infer<typeof listAgentsToolInputSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const listAgentsInputSchema = zodToJsonSchema(
  listAgentsToolInputSchema as any,
  { target: "openAi" }
);
