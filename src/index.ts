/**
 * Agents SDK
 *
 * SDK for building AI agents with tool definitions and JSON-RPC servers.
 *
 * @example
 * ```typescript
 * import {
 *   defineAgent,
 *   defineTool,
 *   createAgentRegistry,
 *   createAgentServer
 * } from '@slashfi/agents-sdk';
 *
 * // Define a tool
 * const greet = defineTool({
 *   name: 'greet',
 *   description: 'Greet a user',
 *   inputSchema: {
 *     type: 'object',
 *     properties: {
 *       name: { type: 'string', description: 'Name to greet' }
 *     },
 *     required: ['name']
 *   },
 *   execute: async (input) => ({ message: `Hello, ${input.name}!` })
 * });
 *
 * // Define an agent
 * const agent = defineAgent({
 *   path: '@my-agent',
 *   entrypoint: 'You are a helpful assistant.',
 *   tools: [greet]
 * });
 *
 * // Create registry and register agent
 * const registry = createAgentRegistry();
 * registry.register(agent);
 *
 * // Start HTTP server
 * const server = createAgentServer(registry, { port: 3000 });
 * await server.start();
 * ```
 *
 * @packageDocumentation
 */

// Types
export type {
  AgentAction,
  AgentConfig,
  AgentDefinition,
  CallAgentAskRequest,
  CallAgentAskResponse,
  CallAgentDescribeToolsRequest,
  CallAgentDescribeToolsResponse,
  CallAgentErrorResponse,
  CallAgentExecuteToolRequest,
  CallAgentExecuteToolResponse,
  CallAgentInvokeRequest,
  CallAgentInvokeResponse,
  CallAgentLoadRequest,
  CallAgentLoadResponse,
  CallAgentRequest,
  CallAgentResponse,
  CallerType,
  CoreContext,
  JsonSchema,
  ToolContext,
  ToolDefinition,
  ToolSchema,
  Visibility,
} from "./types.js";

// Define functions
export { defineAgent, defineTool } from "./define.js";
export type { DefineAgentOptions, DefineToolOptions } from "./define.js";

// Registry
export { createAgentRegistry } from "./registry.js";
export type { AgentRegistry, AgentRegistryOptions } from "./registry.js";

// Server
export { createAgentServer } from "./server.js";
export type { AgentServer, AgentServerOptions } from "./server.js";
