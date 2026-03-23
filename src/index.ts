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
  IntegrationConfig,
  IntegrationMethods,
  IntegrationMethodResult,
  IntegrationMethodContext,
  Visibility,
} from "./types.js";

// Define functions
export { defineAgent, defineTool } from "./define.js";
export type { DefineAgentOptions, DefineToolOptions } from "./define.js";

// Registry
export { createAgentRegistry } from "./registry.js";
export type { AgentRegistry, AgentRegistryOptions } from "./registry.js";

// Server
export { createAgentServer, detectAuth, resolveAuth, canSeeAgent } from "./server.js";
export type { AgentServer, AgentServerOptions, AuthConfig, ResolvedAuth, TrustedIssuer } from "./server.js";

// Secret Collection
export {
  pendingCollections,
  generateCollectionToken,
  cleanupExpiredCollections,
} from "./secret-collection.js";
export type {
  PendingCollection,
  PendingCollectionField,
} from "./secret-collection.js";

// Auth
export {
  createAuthAgent,
  createMemoryAuthStore,
} from "./agent-definitions/auth.js";
export type {
  AuthClient,
  AuthIdentity,
  AuthStore,
  AuthToken,
  CreateAuthAgentOptions,
} from "./agent-definitions/auth.js";

// Build
export { buildAgents } from "./build.js";
export type { BuildAgentsOptions, BuildAgentsResult } from "./build.js";

// Secrets
export {
  createSecretsAgent,
  createInMemorySecretStore,
  isSecretRef,
  processSecretParams,
} from "./agent-definitions/secrets.js";
export type {
  SecretScope,
  SecretStore,
  SecretsAgentOptions,
} from "./agent-definitions/secrets.js";

// Crypto
export { encryptSecret, decryptSecret } from "./crypto.js";

// JWT
export { signJwt, verifyJwt, signJwtES256, verifyJwtLocal, verifyJwtFromIssuer, generateSigningKey, exportSigningKey, importSigningKey, buildJwks } from "./jwt.js";
export type { JwtPayload, AgentJwtPayload, SigningKey, ExportedKeyPair } from "./jwt.js";

// Postgres Secret Store

// Integrations
export {
  createIntegrationsAgent,
  createInMemoryIntegrationStore,
  exchangeCodeForToken,
  refreshAccessToken,
  getDefaultTokenBodyParams,
  getDefaultRefreshBodyParams,
} from "./agent-definitions/integrations.js";
export type {
  IntegrationStore,
  IntegrationsAgentOptions,
  ProviderConfig,
  IntegrationOAuthConfig,
  IntegrationApiConfig,
  IntegrationApiAuthConfig,
  IntegrationCallInput,
  RestCallInput,
  GraphqlCallInput,
  UserConnection,
  ClientAuthMethod,
  TokenContentType,
  TokenExchangeResult,
} from "./agent-definitions/integrations.js";


// Remote Registry
export { createRemoteRegistryAgent } from "./agent-definitions/remote-registry.js";
export type { RemoteRegistryAgentOptions } from "./agent-definitions/remote-registry.js";
// Users
export {
  createUsersAgent,
  createInMemoryUserStore,
} from "./agent-definitions/users.js";
export type {
  User,
  UserIdentity,
  UserStore,
  UsersAgentOptions,
} from "./agent-definitions/users.js";
export * from "./integrations-store.js";
export * from "./integration-interface.js";
export type { ContextFactory } from "./registry.js";
