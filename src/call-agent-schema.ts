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

import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI null-tolerance transform
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively strip null values from an object, converting them to undefined.
 * This is the inverse of zod-to-json-schema's openAi target behavior, which
 * converts .optional() fields to nullable+required in JSON Schema.
 *
 * Used as a z.preprocess() step so that Zod's .optional() (which accepts
 * undefined but not null) works correctly with LLM outputs that send null
 * for "no value" per the OpenAI function calling convention.
 */
export function stripNulls(obj: unknown): unknown {
  if (obj === null) return undefined;
  if (Array.isArray(obj)) return obj.map(stripNulls);
  if (typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        k,
        stripNulls(v),
      ]),
    );
  }
  return obj;
}

/**
 * Wrap a Zod schema with a preprocess step that converts null → undefined.
 * This makes the schema "null-tolerant" — matching what the OpenAI JSON Schema
 * target promises to LLMs (nullable fields) while keeping Zod's .optional()
 * semantics internally.
 *
 * @example
 * ```ts
 * const schema = z.object({ name: z.string().optional() });
 * const tolerant = nullTolerant(schema);
 * tolerant.parse({ name: null }); // { name: undefined } — no error
 * ```
 */
export function nullTolerant<T extends ZodTypeAny>(schema: T) {
  return z.preprocess(stripNulls, schema) as unknown as T;
}

/**
 * Convert a Zod schema to JSON Schema using the OpenAI target,
 * which makes all optional fields nullable+required.
 *
 * This is the standard way to generate input schemas for MCP tools
 * that will be called by LLMs.
 */
export function zodToOpenAiJsonSchema(
  schema: ZodTypeAny,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return zodToJsonSchema(schema as any, { target: "openAi" }) as Record<
    string,
    unknown
  >;
}

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
  action: z
    .literal("list_resources")
    .describe(
      "List all resources available on an agent — docs, auth instructions, config schemas, etc.",
    ),
});

/** Read resources: fetch one or more resources by URI */
export const readResourcesActionSchema = callAgentBaseSchema.extend({
  action: z
    .literal("read_resources")
    .describe(
      "Fetch one or more resources by URI. Use list_resources first to discover available URIs.",
    ),
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
    (s) => (s.shape as { action: z.ZodLiteral<AgentAction> }).action.value,
  );

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema for MCP (derived from zod)
// ─────────────────────────────────────────────────────────────────────────────

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
export const callAgentInputSchema = zodToOpenAiJsonSchema(
  callAgentToolInputSchema,
);

/**
 * Null-tolerant validation schema for `call_agent`.
 * Accepts null values where the JSON Schema promises nullable,
 * converting them to undefined before Zod validation.
 */
export const callAgentValidationSchema = nullTolerant(
  callAgentToolInputSchema,
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
    .describe("Maximum number of results per page (default: 20)"),
  cursor: z
    .string()
    .optional()
    .describe(
      "Pagination cursor from a previous response's nextCursor field.",
    ),
});

export type ListAgentsInput = z.infer<typeof listAgentsToolInputSchema>;

export const listAgentsInputSchema = zodToOpenAiJsonSchema(
  listAgentsToolInputSchema,
);

export const listAgentsValidationSchema = nullTolerant(
  listAgentsToolInputSchema,
);
