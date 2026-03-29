/**
 * Serialized Agent Definition
 *
 * Pure-data, JSON-serializable representation of an agent.
 * No execute functions, no runtime hooks — just schemas and metadata.
 *
 * This is the universal IR:
 * - Codegen produces it (MCP introspection → SerializedAgentDefinition)
 * - Registry stores it (JSON in DB or filesystem)
 * - API serves it (GET /agents/:name → SerializedAgentDefinition)
 * - createClient() hydrates it (definition → typed proxy with real calls)
 */

import type { JsonSchema, SecurityScheme } from "./types.js";

// ============================================
// Serialized Tool
// ============================================

export interface SerializedTool {
  /** Tool name (unique within agent) */
  name: string;
  /** Short description for tool discovery */
  description: string;
  /** JSON Schema for input parameters */
  inputSchema: JsonSchema;
  /** JSON Schema for output (optional) */
  outputSchema?: JsonSchema;
}

// ============================================
// Serialized Agent Definition
// ============================================

export interface SerializedAgentDefinition {
  /** Agent path (e.g., 'notion', 'linear', 'github') */
  path: string;
  /** Human-readable name */
  name: string;
  /** Short description */
  description: string;
  /** Version of the definition */
  version: string;
  /** Visibility level */
  visibility: "public" | "private";
  /** Auth requirements */
  auth?: SecurityScheme;
  /** MCP server source command (e.g., 'npx @notionhq/notion-mcp-server') */
  serverSource?: string;
  /** Server info from MCP introspection */
  serverInfo?: {
    name: string;
    version: string;
  };
  /** Tool definitions (schemas only, no execute) */
  tools: SerializedTool[];
  /** ISO timestamp of when this was generated */
  generatedAt?: string;
  /** SDK version used for codegen */
  sdkVersion?: string;
}

// ============================================
// Serialization helpers
// ============================================

import type { AgentDefinition, ToolContext, ToolDefinition } from "./types.js";

/**
 * Serialize an AgentDefinition to its pure-data representation.
 * Strips execute functions, runtime hooks, listeners, etc.
 */
export function serializeAgent(
  agent: AgentDefinition,
  meta?: { serverSource?: string; version?: string },
): SerializedAgentDefinition {
  return {
    path: agent.path,
    name: agent.config?.name ?? agent.path,
    description: agent.config?.description ?? "",
    version: meta?.version ?? "1.0.0",
    visibility: (agent.visibility as "public" | "private") ?? "public",
    auth: agent.config?.security,
    serverSource: meta?.serverSource,
    tools: agent.tools.map(serializeTool),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Serialize a single ToolDefinition to its pure-data representation.
 */
export function serializeTool(
  tool: ToolDefinition<ToolContext, unknown, unknown>,
): SerializedTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  };
}
