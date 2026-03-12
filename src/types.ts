/**
 * Core Types for Agents SDK
 *
 * Defines the fundamental types for agent definitions, tools, and contexts.
 */

// ============================================
// JSON Schema
// ============================================

/**
 * JSON Schema definition for tool input parameters.
 */
export type JsonSchema = {
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

// ============================================
// Agent Configuration
// ============================================

/**
 * Supported actions for agents.
 */
export type AgentAction =
  | "invoke"
  | "ask"
  | "execute_tool"
  | "describe_tools"
  | "load"
  | "learn";

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
    [key: string]: unknown;
  };

  /** Additional configuration */
  [key: string]: unknown;
}

// ============================================
// Context Types
// ============================================

/**
 * Caller type for context.
 */
export type CallerType = "agent" | "user" | "system";

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
}

// ============================================
// Hook Contexts
// ============================================

/**
 * Context for the onInvoke hook.
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
 */
export interface TickContext extends CoreContext {
  /** Timestamp of this tick */
  timestamp: number;

  /** Previous tick timestamp (for delta calculations) */
  previousTick?: number;
}

/**
 * Context for the onStep hook (after each LLM step).
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
 * Context for the onLearn hook.
 */
export interface LearnContext extends CoreContext {
  /** Content to internalize */
  content: string;

  /** How long to remember */
  scope: "session" | "persistent" | "global";

  /** Category/topic for organization */
  category?: string;

  /** Who is teaching */
  callerId: string;
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
 */
export interface AgentRuntime {
  /**
   * Called when the agent is invoked (new session or message).
   * Use for setup, context hydration, routing decisions.
   */
  onInvoke?: (ctx: InvokeContext) => Promise<void>;

  /**
   * Called periodically for background work.
   * Use for polling, cleanup, proactive actions.
   */
  onTick?: (ctx: TickContext) => Promise<void>;

  /**
   * Called after each LLM step completes.
   * Use for logging, metrics, side effects.
   */
  onStep?: (ctx: StepContext) => Promise<void>;

  /**
   * Called when an external message arrives.
   * Use for routing, filtering, pre-processing.
   */
  onMessage?: (ctx: MessageContext) => Promise<void>;

  /**
   * Called when learning new information.
   * Use for memory management, knowledge updates.
   */
  onLearn?: (ctx: LearnContext) => Promise<void>;

  /**
   * Dynamically select which tools to expose for a request.
   * Return tool names to include. If not implemented, all tools exposed.
   */
  selectTools?: (ctx: ToolSelectionContext) => Promise<string[]>;

  /**
   * Called once when the agent starts.
   */
  onStart?: () => Promise<void>;

  /**
   * Called once when the agent shuts down.
   */
  onStop?: () => Promise<void>;
}

// ============================================
// Tool Types
// ============================================

/**
 * Visibility level for tools and agents.
 */
export type Visibility = "public" | "internal" | "private";

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
   */
  execute: (input: TInput, ctx: TContext) => Promise<TOutput>;
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
   * Runtime hooks factory.
   * Called once to create the runtime for this agent.
   */
  runtime?: () => AgentRuntime;

  /** Visibility level for the agent itself */
  visibility?: Visibility;

  /** Explicit list of callers allowed to invoke this agent */
  allowedCallers?: string[];
}

// ============================================
// CallAgent Request Types
// ============================================

/** Base request fields */
interface CallAgentBaseRequest {
  /** Target agent path */
  path: string;
  /** Caller ID for access control */
  callerId?: string;
  /** Caller type */
  callerType?: CallerType;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Invoke: fire-and-forget */
export interface CallAgentInvokeRequest extends CallAgentBaseRequest {
  action: "invoke";
  prompt: string;
  sessionId?: string;
  branchAttributes?: Record<string, string>;
}

/** Ask: invoke and wait for response */
export interface CallAgentAskRequest extends CallAgentBaseRequest {
  action: "ask";
  prompt: string;
  sessionId?: string;
  branchAttributes?: Record<string, string>;
}

/** Execute a specific tool */
export interface CallAgentExecuteToolRequest extends CallAgentBaseRequest {
  action: "execute_tool";
  tool: string;
  params?: Record<string, unknown>;
}

/** Get tool schemas */
export interface CallAgentDescribeToolsRequest extends CallAgentBaseRequest {
  action: "describe_tools";
  /** Optional: filter to specific tools */
  tools?: string[];
}

/** Load: get agent definition */
export interface CallAgentLoadRequest extends CallAgentBaseRequest {
  action: "load";
}

/** Learn: teach the agent something */
export interface CallAgentLearnRequest extends CallAgentBaseRequest {
  action: "learn";
  content: string;
  scope?: "session" | "persistent" | "global";
  category?: string;
}

/** Union of all request types */
export type CallAgentRequest =
  | CallAgentInvokeRequest
  | CallAgentAskRequest
  | CallAgentExecuteToolRequest
  | CallAgentDescribeToolsRequest
  | CallAgentLoadRequest
  | CallAgentLearnRequest;

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

/** Success response for load */
export interface CallAgentLoadResponse {
  success: true;
  result: {
    path: string;
    entrypoint: string;
    config: AgentConfig | undefined;
    tools: ToolSchema[];
  };
}

/** Success response for learn */
export interface CallAgentLearnResponse {
  success: true;
  action: "stored" | "updated" | "ignored";
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
  | CallAgentLearnResponse
  | CallAgentErrorResponse;
