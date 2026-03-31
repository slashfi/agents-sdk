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
  AgentRefEntry,
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
  ApiKeySecurityScheme,
  HttpSecurityScheme,
  NoneSecurityScheme,
  OAuth2SecurityScheme,
  SecurityScheme,
  IntegrationMethods,
  IntegrationMethodResult,
  IntegrationMethodContext,
  IntegrationHooks,
  Visibility,
} from "./types.js";

// Define functions
export { defineAgent, defineTool } from "./define.js";
export type { DefineAgentOptions, DefineToolOptions, AgentWithHooks, ToolWithHooks } from "./define.js";

// Registry
export { createAgentRegistry, agentFromSerialized } from "./registry.js";
export type {
  AgentRegistry,
  AgentRegistryOptions,
  RegistryMiddleware,
} from "./registry.js";

// Events
export { createEventBus } from "./events.js";
export type {
  EventBus,
  EventType,
  SystemEventType,
  CustomEventMap,
  EventCallback,
  AgentEvent,
  BaseEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolErrorEvent,
  StepEvent,
  InvokeEvent,
  CallEvent,
  EventMap,
  SystemEventMap,
  ListenerEntry,
} from "./events.js";

// Server
export {
  createAgentServer,
  detectAuth,
  resolveAuth,
  canSeeAgent,
} from "./server.js";
export type {
  AgentServer,
  AgentServerOptions,
  AuthConfig,
  OAuthIdentityProvider,
  ResolvedAuth,
  TrustedIssuer,
} from "./server.js";
export { createOIDCSignIn } from "./oidc-signin.js";
export type { OIDCProviderConfig, OIDCSignInHandler } from "./oidc-signin.js";

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
export {
  signJwt,
  verifyJwt,
  signJwtES256,
  verifyJwtLocal,
  verifyJwtFromIssuer,
  generateSigningKey,
  exportSigningKey,
  importSigningKey,
  buildJwks,
} from "./jwt.js";
export type {
  JwtPayload,
  AgentJwtPayload,
  SigningKey,
  ExportedKeyPair,
} from "./jwt.js";

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
export {
  createKeyManager,
  type KeyManager,
  type KeyStore,
  type KeyManagerOptions,
  type StoredKey,
  type KeyStatus,
} from "./key-manager.js";

// Config & Consumer
export {
  normalizeRef,
  normalizeRegistry,
  isSecretUrl,
  isSecretUri,
} from "./define-config.js";
export type {
  RegistryAuth,
  RegistryEntry,
  RefConfig,
  RefEntry,
  ConsumerConfig,
  ResolvedRegistry,
  ResolvedRef,
  ResolvedConfig,
} from "./define-config.js";

export { createRegistryConsumer } from "./registry-consumer.js";
export type {
  RegistryConsumer,
  RegistryConsumerOptions,
  RegistryConfiguration,
  AgentListing,
  SecretResolver,
} from "./registry-consumer.js";

// Codegen
export { codegen, useAgent, listAgentTools } from "./codegen.js";
export type {
  CodegenOptions,
  CodegenResult,
  CodegenManifest,
  McpToolDefinition,
  McpServerInfo,
  McpTransport,
  ServerSource,
} from "./codegen.js";

// ============================================
// Serialized Agent Definitions
// ============================================

export { serializeAgent, serializeTool } from "./serialized.js";
export type {
  SerializedAgentDefinition,
  SerializedTool,
} from "./serialized.js";

// ============================================
// Agent Client
// ============================================

export { createClient } from "./client.js";
export type {
  AgentClient,
  CreateClientOptions,
} from "./client.js";

// ============================================
// JSONC Parser
// ============================================

export { parseJsonc, readJsoncFile } from "./jsonc.js";

// ============================================
// Pack & Publish
// ============================================

export { pack, publish } from "./pack.js";
export type {
  PackOptions,
  PackResult,
  PublishOptions,
  VersionMeta,
  VersionChanges,
} from "./pack.js";

// ============================================
// Introspect
// ============================================

export { introspectMcp } from "./introspect.js";
export type { IntrospectOptions } from "./introspect.js";

// ============================================
// call_agent Schema (shared source of truth)
// ============================================

export {
  callAgentInputSchema,
  CALL_AGENT_ACTIONS,
} from "./call-agent-schema.js";

// ============================================
// Validation
// ============================================

export {
  SerializedAgentDefinitionSchema,
  SerializedToolSchema,
  validateDefinition,
  assertValidDefinition,
} from "./validate.js";
export type { ValidationResult } from "./validate.js";

// ============================================
// BM25 Search
// ============================================

export {
  createBM25Index,
} from "./bm25.js";
export type {
  BM25Options,
  BM25Document,
  BM25Result,
} from "./bm25.js";
