/**
 * Agents SDK
 *
 * SDK for building AI agents with tool definitions, JSON-RPC servers,
 * and built-in OAuth2 authentication.
 *
 * @example
 * ```typescript
 * import {
 *   defineAgent,
 *   defineTool,
 *   createAgentRegistry,
 *   createAgentServer,
 *   createAuthAgent,
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
 * // Create registry with auth
 * const registry = createAgentRegistry();
 * registry.register(createAuthAgent({ rootKey: process.env.ROOT_KEY! }));
 * registry.register(agent);
 *
 * // Start server - auth auto-detected
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
  AgentRuntime,
  CallAgentAskRequest,
  CallAgentAskResponse,
  CallAgentDescribeToolsRequest,
  CallAgentDescribeToolsResponse,
  CallAgentErrorResponse,
  CallAgentExecuteToolRequest,
  CallAgentExecuteToolResponse,
  CallAgentInvokeRequest,
  CallAgentInvokeResponse,
  CallAgentLearnRequest,
  CallAgentLearnResponse,
  CallAgentLoadRequest,
  CallAgentLoadResponse,
  CallAgentRequest,
  CallAgentResponse,
  CallerType,
  CoreContext,
  InvokeContext,
  JsonSchema,
  LearnContext,
  MessageContext,
  StepContext,
  TickContext,
  ToolContext,
  ToolDefinition,
  ToolSchema,
  ToolSelectionContext,
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

// Auth
export { createAuthAgent, createMemoryAuthStore } from "./auth.js";
export type {
  AuthClient,
  AuthIdentity,
  AuthStore,
  AuthToken,
  CreateAuthAgentOptions,
} from "./auth.js";

// Build
export { buildAgents } from "./build.js";
export type { BuildAgentsOptions, BuildAgentsResult } from "./build.js";

// Secrets
export { createInMemorySecretStore, isSecretRef, processSecretParams } from "./secrets.js";
export type { SecretStore } from "./secrets.js";

// JWT
export { signJwt, verifyJwt } from "./jwt.js";
export type { JwtPayload } from "./jwt.js";
