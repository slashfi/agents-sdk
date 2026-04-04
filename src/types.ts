/**
 * Core Types for Agents SDK
 *
 * Defines the fundamental types for agent definitions, tools, and contexts.
 */

import type { EventCallback, EventType } from "./events.js";
import type { AgentAction, CallerType } from "./call-agent-schema.js";

/** Internal listener entry stored on agents/tools */
export interface ListenerEntry {
  eventType: EventType;
  callback: EventCallback<EventType>;
  toolScope?: string;
}

// ============================================
// JSON Schema
// ============================================

/**
 * JSON Schema definition for tool input parameters.
 */
export type JsonSchema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null" | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  /** Agent refs (paths to other agents this agent can call) */
  refs?: Record<string, { description?: string }>;

  /** Tools to expose publicly (by name) */
  public?: { tools?: string[] };
  [key: string]: unknown;
};

// ============================================
// Integration Config
// ============================================

/**
 * Integration configuration for agents that act as integrations.
 * When set on an agent's config, the agent is discoverable as an
 * integration by the registry and the @integrations agent.
 *
 * This is how "each integration = its own agent" works:
 * any agent can declare itself as an integration by setting this field.
 * Each agent handles its own setup through its own tools.
 */
/**
 * Standard result type for integration method callbacks.
 */
export interface IntegrationMethodResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Context passed to integration method callbacks.
 * Extends ToolContext with the integration-specific info.
 */
export interface IntegrationMethodContext extends ToolContext {
  /** The provider ID from the integration config */
  provider: string;
}

/**
 * Callback methods that integration agents implement.
 * These provide a standard interface for @integrations to interact
 * with any integration uniformly, regardless of internal tool schemas.
 */
export interface IntegrationMethods {
  /** Configure/initialize the integration (e.g., add a DB connection, set API key) */
  setup(
    params: Record<string, unknown>,
    ctx: IntegrationMethodContext,
  ): Promise<IntegrationMethodResult>;
  /** List configured instances (e.g., list DB connections, list repos) */
  list(
    params: Record<string, unknown>,
    ctx: IntegrationMethodContext,
  ): Promise<IntegrationMethodResult>;
  /** Establish connection or authenticate (e.g., test DB connectivity, OAuth flow) */
  connect(
    params: Record<string, unknown>,
    ctx: IntegrationMethodContext,
  ): Promise<IntegrationMethodResult>;
  /** Get details of a specific instance */
  get(
    params: Record<string, unknown>,
    ctx: IntegrationMethodContext,
  ): Promise<IntegrationMethodResult>;
  /** Modify an existing configuration */
  update(
    params: Record<string, unknown>,
    ctx: IntegrationMethodContext,
  ): Promise<IntegrationMethodResult>;
}

/** Hooks for agents that implement the integrations interface. */
export interface IntegrationHooks {
  /** Provider metadata */
  provider: string;
  displayName: string;
  icon?: string;
  category?: string;
  description?: string;

  /** Set up this integration (discover, configure, establish trust) */
  setup?(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<IntegrationMethodResult>;
  /** Connect a user to this integration (OAuth, identity linking) */
  connect?(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<IntegrationMethodResult>;
  /** Discover available instances of this integration */
  discover?(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<IntegrationMethodResult>;
  /** List connected instances */
  list?(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<IntegrationMethodResult>;
  /** Get details of a specific instance */
  get?(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<IntegrationMethodResult>;
  /** Update an existing instance config */
  update?(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<IntegrationMethodResult>;
}
export interface IntegrationConfig {
  /** Provider identifier (e.g., "databases", "slack", "github") */
  provider: string;

  /** Display name shown in dashboards and listings */
  displayName: string;

  /** Icon identifier or URL */
  icon?: string;

  /** Category for grouping (e.g., "infrastructure", "communication", "developer") */
  category?: string;

  /** Brief description of what connecting this integration enables */
  description?: string;

  /** JSON Schema for the setup/create params. Used by discover_integrations. */
  setupSchema?: Record<string, unknown>;

  /** JSON Schema for the connect params (e.g., OAuth scopes). */
  connectSchema?: Record<string, unknown>;
}

// ============================================
// Security Scheme
// ============================================

/**
 * OAuth 2.0 Authorization Code flow configuration.
 * Used by agents that wrap APIs requiring user-authorized access
 * (e.g. Notion, Slack, GitHub, Linear, Google).
 */
export interface OAuth2SecurityScheme {
  type: "oauth2";
  flows: {
    authorizationCode: {
      /** URL to redirect users for authorization */
      authorizationUrl: string;
      /** URL to exchange authorization code for tokens */
      tokenUrl: string;
      /** URL for token refresh (defaults to tokenUrl) */
      refreshUrl?: string;
      /** Available scopes: key = scope name, value = description */
      scopes?: Record<string, string>;
      /** How client credentials are sent */
      clientAuth?: "client_secret_post" | "client_secret_basic";
    };
  };
}

/**
 * API key authentication.
 * Used by agents that wrap APIs using a single key
 * (e.g. OpenAI, Anthropic, Stripe, Datadog).
 */
export interface ApiKeySecurityScheme {
  type: "apiKey";
  /** Where the key is sent */
  in: "header" | "query";
  /** Header or query parameter name (e.g. "X-API-Key", "Authorization") */
  name: string;
  /** Optional prefix (e.g. "Bearer" for Authorization header) */
  prefix?: string;
}

/**
 * HTTP authentication (Bearer token, Basic auth).
 */
export interface HttpSecurityScheme {
  type: "http";
  scheme: "bearer" | "basic";
}

/**
 * No authentication required.
 */
export interface NoneSecurityScheme {
  type: "none";
}

/**
 * Security scheme for an agent — describes what authentication the
 * agent's target API requires from consumers.
 *
 * Borrowed from OpenAPI Security Scheme Object, simplified for agents.
 * The system uses this to:
 * - Know what credentials a tenant admin needs to provide (OAuth app creds)
 * - Know what flow a user needs to complete (OAuth exchange)
 * - Know how to send credentials when calling the API
 *
 * @example
 * ```typescript
 * // OAuth 2.0 (Notion, Slack, GitHub)
 * security: {
 *   type: 'oauth2',
 *   flows: {
 *     authorizationCode: {
 *       authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
 *       tokenUrl: 'https://api.notion.com/v1/oauth/token',
 *       clientAuth: 'client_secret_basic',
 *     }
 *   }
 * }
 *
 * // API Key (OpenAI, Stripe)
 * security: { type: 'apiKey', in: 'header', name: 'Authorization', prefix: 'Bearer' }
 *
 * // No auth (public API)
 * security: { type: 'none' }
 * ```
 */
export type SecurityScheme =
  | OAuth2SecurityScheme
  | ApiKeySecurityScheme
  | HttpSecurityScheme
  | NoneSecurityScheme;

/**
 * Lightweight security summary for agent listings.
 * The full SecurityScheme has all the details; this is the
 * directory-level overview (e.g., in list_agents responses).
 */
export interface SecuritySchemeSummary {
  type: SecurityScheme['type'];
  [key: string]: unknown;
}

/**
 * A static resource exposed by an agent.
 * Well-known resources:
 * - `AUTH.md` — LLM-readable auth/connection setup instructions
 */
export interface AgentResource {
  /** Resource URI (e.g., 'AUTH.md') */
  uri: string;
  /** Human-readable name */
  name?: string;
  /** MIME type (defaults to text/markdown for .md) */
  mimeType?: string;
  /** The resource content (populated on read_resources, omitted on list) */
  content?: string;
}

// ============================================
// Agent Configuration
// ============================================

// AgentAction is derived from the zod schema in call-agent-schema.ts
export type { AgentAction } from "./call-agent-schema.js";

/**
 * Agent configuration options.
 */
export interface AgentConfig {
  /** Unique identifier for the agent */
  id?: string;

  /** Human-readable name */
  name?: string;

  /** Description of what the agent does */
  description?: string;

  /** Which actions this agent supports */
  supportedActions?: AgentAction[];

  /** LLM model to use */
  model?: string;

  /** Model-specific parameters */
  modelParams?: {
    maxTokens?: number;
    temperature?: number;
    /** Agent refs (paths to other agents this agent can call) */
    refs?: Record<string, { description?: string }>;

    /** Tools to expose publicly (by name) */
    public?: { tools?: string[] };
    [key: string]: unknown;
  };

  /**
   * Integration config. When set, this agent is discoverable as an integration.
   * Any agent can opt-in by providing this field.
   * @see IntegrationConfig
   */
  integration?: IntegrationConfig;

  /**
   * Security scheme — describes what authentication the agent's
   * target API requires. Used by the registry to communicate
   * credential requirements to consumers.
   *
   * @see SecurityScheme
   */
  security?: SecurityScheme;

  /**
   * Agent resources — static files/documents the agent exposes.
   * Well-known resources:
   * - `AUTH.md` — LLM-readable auth setup instructions
   */
  resources?: AgentResource[];

  /** Additional configuration */
  /** Agent refs (paths to other agents this agent can call) */
  refs?: Record<string, { description?: string }>;

  /** Tools to expose publicly (by name) */
  public?: { tools?: string[] };
  [key: string]: unknown;
}

// ============================================
// Context Types
// ============================================

/**
 * Caller type for context.
 */
export type { CallerType } from "./call-agent-schema.js";

/**
 * Core context shared across all executions.
 */
export interface CoreContext {
  /** Tenant ID for multi-tenant deployments */
  tenantId: string;

  /** Agent path being executed */
  agentPath: string;

  /** Branch ID for session context */
  branchId?: string;

  /** Current node ID within the branch */
  nodeId?: string;

  /** Branch attributes */
  branchAttributes?: Record<string, string>;

  /** ID of the caller */
  callerId?: string;

  /** Type of caller */
  callerType?: CallerType;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Context passed to tool execution.
 */
export interface ToolContext extends CoreContext {
  /** ID of the caller (required for tools) */
  callerId: string;

  /** Type of caller (required for tools) */
  callerType: CallerType;

  /** Application-specific extensions (e.g., OS services, stores) */
  /** Agent refs (paths to other agents this agent can call) */
  refs?: Record<string, { description?: string }>;

  /** Tools to expose publicly (by name) */
  public?: { tools?: string[] };
  [key: string]: unknown;
}

// ============================================
// Hook Contexts
// ============================================

/**
 * Context for the onInvoke hook.
 *
 * @experimental The onInvoke hook is not yet implemented.
 */
export interface InvokeContext extends CoreContext {
  /** The prompt/message that triggered this invocation */
  prompt: string;

  /** Session ID for continuity */
  sessionId?: string;

  /** Caller identity */
  callerId: string;
  callerType: CallerType;
}

/**
 * Context for the onTick hook (heartbeat/scheduled).
 *
 * @experimental The onTick hook is not yet implemented.
 */
export interface TickContext extends CoreContext {
  /** Timestamp of this tick */
  timestamp: number;

  /** Previous tick timestamp (for delta calculations) */
  previousTick?: number;
}

/**
 * Context for the onStep hook (after each LLM step).
 *
 * @experimental The onStep hook is not yet implemented.
 */
export interface StepContext extends CoreContext {
  /** Sequence number in the branch */
  sequence: number;

  /** Type of step that completed */
  stepType: "user" | "assistant" | "tool_use" | "tool_result";

  /** Whether this step used tools */
  usedTools: boolean;
}

/**
 * Context for the onMessage hook (external message arrived).
 *
 * @experimental The onMessage hook is not yet implemented.
 */
export interface MessageContext extends CoreContext {
  /** The message content */
  content: string;

  /** Source of the message */
  source: {
    type: "slack" | "email" | "api" | "thread" | string;
    /** External ID (e.g., channel:thread_ts for Slack) */
    externalId?: string;
  };

  /** Sender identity */
  senderId: string;
  senderType: "human" | "agent" | "bot" | "system";
}

/**
 * Context for dynamic tool selection.
 */
export interface ToolSelectionContext extends CoreContext {
  /** The current prompt/message */
  prompt: string;

  /** Caller identity and role */
  caller: {
    id: string;
    type: CallerType;
    role?: string;
  };

  /** Recent messages for context */
  recentMessages?: string[];
}

// ============================================
// Runtime Hooks
// ============================================

/**
 * Agent runtime hooks.
 *
 * All hooks are optional. Agents without a runtime use default behavior.
 *
 * Currently supported:
 * - `selectTools` - dynamic tool filtering
 *
 * Other hooks are defined for future use but not yet wired up.
 */
export interface AgentRuntime {
  /**
   * Called when the agent is invoked (new session or message).
   * Use for setup, context hydration, routing decisions.
   *
   * @experimental Not yet implemented in the agent runtime.
   */
  onInvoke?: (ctx: InvokeContext) => Promise<void>;

  /**
   * Called periodically for background work.
   * Use for polling, cleanup, proactive actions.
   *
   * @experimental Not yet implemented in the agent runtime.
   */
  onTick?: (ctx: TickContext) => Promise<void>;

  /**
   * Called after each LLM step completes.
   * Use for logging, metrics, side effects.
   *
   * @experimental Not yet implemented in the agent runtime.
   */
  onStep?: (ctx: StepContext) => Promise<void>;

  /**
   * Called when an external message arrives.
   * Use for routing, filtering, pre-processing.
   *
   * @experimental Not yet implemented in the agent runtime.
   */
  onMessage?: (ctx: MessageContext) => Promise<void>;

  /**
   * Dynamically select which tools to expose for a request.
   * Return tool names to include. If not implemented, all tools exposed.
   */
  selectTools?: (ctx: ToolSelectionContext) => Promise<string[]>;

  /**
   * Called once when the agent starts.
   *
   * @experimental Not yet implemented in the agent runtime.
   */
  onStart?: () => Promise<void>;

  /**
   * Called once when the agent shuts down.
   *
   * @experimental Not yet implemented in the agent runtime.
   */
  onStop?: () => Promise<void>;
}

// ============================================
// Tool Types
// ============================================

/**
 * Visibility level for tools and agents.
 */
export type Visibility = "public" | "authenticated" | "internal" | "private";

/**
 * A tool definition with execute function.
 */
export interface ToolDefinition<
  TContext extends ToolContext = ToolContext,
  TInput = unknown,
  TOutput = unknown,
> {
  /** Tool name (unique within agent) */
  name: string;

  /** Short description for tool discovery */
  description: string;

  /** JSON Schema for input parameters */
  inputSchema: JsonSchema;

  /** JSON Schema for output (optional, for documentation) */
  outputSchema?: JsonSchema;

  /**
   * Visibility level:
   * - 'public': Anyone can call this tool
   * - 'internal': Only agents in the same registry can call
   * - 'private': Only the owning agent can call
   */
  visibility?: Visibility;

  /**
   * Explicit list of callers allowed to use this tool.
   */
  allowedCallers?: string[];

  /**
   * Execute the tool with validated input.
   * Optional — some registries load tool implementations dynamically.
   */
  execute?: (input: TInput, ctx: TContext) => Promise<TOutput>;

  /**
   * Path to the tool source file (e.g., '/agents/@clock/timer.tool.ts').
   * Used for tool discovery and prompt composition.
   */
  path?: string;

  /**
   * Full documentation content for system prompt composition.
   * When set, rendered directly into the agent's system prompt.
   */
  doc?: string;

  /**
   * Internal: event listeners registered via tool.on().
   * Collected by the registry on registration.
   */
  _listeners?: ListenerEntry[];
}

/**
 * Tool schema for describe_tools response.
 */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

// ============================================
// Agent Definition
// ============================================

/**
 * Complete agent definition.
 */
export interface AgentDefinition<TContext extends ToolContext = ToolContext> {
  /** Agent path (e.g., '@example', '/agents/my-agent') */
  path: string;

  /** System prompt / entrypoint content */
  entrypoint: string;

  /** Agent configuration */
  config?: AgentConfig;

  /** Tools provided by this agent */
  tools: ToolDefinition<TContext, unknown, unknown>[];

  /**
   * Registry hosting mode:
   * - 'direct': registry hosts and serves this agent's tools (default)
   * - 'redirect': registry catalogs this agent but clients connect to `upstream` directly
   */
  mode?: 'direct' | 'redirect';

  /**
   * Upstream URL for redirect-mode agents.
   * When mode is 'redirect', clients should connect to this URL instead of the registry.
   */
  upstream?: string;

  /**
   * Runtime hooks factory.
   * Called once to create the runtime for this agent.
   */
  runtime?: () => AgentRuntime;

  /** Visibility level for the agent itself */
  visibility?: Visibility;

  /** Explicit list of callers allowed to invoke this agent */
  allowedCallers?: string[];

  /**
   * Integration method callbacks.
   * When set alongside config.integration, this agent can be called
   * by @integrations via standard methods (setup, list, connect, get, update).
   */

  /**
   * Lazy loader for lifecycle listeners.
   * Called once to load runtime hooks exported from the agent's entrypoint module.
   */
  loadListeners?: () => Promise<unknown>;

  /**
   * Internal: event listeners registered via agent.on().
   * Collected by the registry on registration.
   */
  _listeners?: ListenerEntry[];
}

// ============================================
// CallAgent Request Types (derived from zod schemas)
// ============================================

export type {
  CallAgentRequest,
  CallAgentInvokeRequest,
  CallAgentAskRequest,
  CallAgentExecuteToolRequest,
  CallAgentDescribeToolsRequest,
  CallAgentLoadRequest,
} from "./call-agent-schema.js";

// ============================================
// CallAgent Response Types
// ============================================

/** Success response for invoke */
export interface CallAgentInvokeResponse {
  success: true;
  branchId: string;
}

/** Success response for ask */
export interface CallAgentAskResponse {
  success: true;
  branchId: string;
  response: string;
}

/** Success response for execute_tool */
export interface CallAgentExecuteToolResponse {
  success: true;
  result: unknown;
}

/** Success response for describe_tools */
export interface CallAgentDescribeToolsResponse {
  success: true;
  tools: ToolSchema[];
}

/** A resolved agent ref with its discovered tools */
export interface AgentRefEntry {
  key: string;
  path: string;
  description: string;
  tools: ToolSchema[];
}

/** Success response for load */
export interface CallAgentLoadResponse {
  success: true;
  result: {
    path: string;
    entrypoint: string;
    systemPrompt: string;
    contextMessages: string[];
    config: AgentConfig | undefined;
    tools: ToolSchema[];
    agentRefs: AgentRefEntry[];
  };
}

/** Callback response (fire-and-forget confirmation) */
export interface CallAgentCallbackResponse {
  success: true;
  callbackId: string;
}

/** List resources response */
export interface CallAgentListResourcesResponse {
  success: true;
  agentPath: string;
  resources: Array<{
    uri: string;
    name?: string;
    mimeType?: string;
  }>;
}

/** Read resources response */
export interface CallAgentReadResourcesResponse {
  success: true;
  agentPath: string;
  resources: Array<{
    uri: string;
    name?: string;
    mimeType?: string;
    content?: string;
    error?: string;
  }>;
}

/** Error response */
export interface CallAgentErrorResponse {
  success: false;
  error: string;
  code?: string;
}

/** Union of all response types */
export type CallAgentResponse =
  | CallAgentInvokeResponse
  | CallAgentAskResponse
  | CallAgentExecuteToolResponse
  | CallAgentDescribeToolsResponse
  | CallAgentLoadResponse
  | CallAgentCallbackResponse
  | CallAgentListResourcesResponse
  | CallAgentReadResourcesResponse
  | CallAgentErrorResponse;
