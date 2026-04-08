/**
 * Event Bus — Generic event system for the agents-sdk.
 *
 * Three scopes, one bus:
 *   registry.on(event, cb)  — global, all agents
 *   agent.on(event, cb)     — scoped to one agent
 *   tool.on(event, cb)      — scoped to one tool
 *
 * All are sugar for the same underlying EventBus.
 * Filtering happens in the callback, not the API.
 */

import type { AgentDefinition, CallAgentRequest, CallAgentResponse } from "./types.js";
// =============================================================================
// Event Types
// =============================================================================

/**
 * Built-in system event types managed by the runtime.
 */
export type SystemEventType =
  | "tool/call"
  | "tool/result"
  | "tool/error"
  | "step"
  | "invoke"
  | "tools/call/call_agent"
  | "tools/call/list_agents";

/**
 * Augmentable map for custom event types. Consumers extend this
 * via declaration merging to register their own events:
 *
 * ```ts
 * declare module '@slashfi/agents-sdk' {
 *   interface CustomEventMap {
 *     'callback/resolve': MyCallbackResolveEvent;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface CustomEventMap {}

/**
 * All event types — system + consumer-defined custom events.
 */
export type EventType = SystemEventType | Extract<keyof CustomEventMap, string>;

/**
 * Base event shape — every event has these fields.
 */
export interface BaseEvent {
  /** Event type */
  type: string;
  /** Agent path (e.g., '/agents/atlas-slack') */
  agentPath: string;
  /** Timestamp */
  timestamp: number;
}

/**
 * Event emitted before a tool executes.
 */
export interface ToolCallEvent extends BaseEvent {
  type: "tool/call";
  /** Tool name */
  tool: string;
  /** Input parameters */
  params: unknown;
}

/**
 * Event emitted after a tool succeeds.
 */
export interface ToolResultEvent extends BaseEvent {
  type: "tool/result";
  /** Tool name */
  tool: string;
  /** Input parameters */
  params: unknown;
  /** Tool result */
  result: unknown;
  /** Execution duration in ms */
  durationMs: number;
}

/**
 * Event emitted when a tool throws.
 */
export interface ToolErrorEvent extends BaseEvent {
  type: "tool/error";
  /** Tool name */
  tool: string;
  /** Input parameters */
  params: unknown;
  /** The error */
  error: unknown;
  /** Execution duration in ms */
  durationMs: number;
}

/**
 * Event emitted when a step finishes.
 */
export interface StepEvent extends BaseEvent {
  type: "step";
  /** Branch ID */
  branchId: string;
  /** Step outcome */
  stepResult: "continue" | "stop";
  /** Tools called in this step */
  toolNames?: string[];
}

/**
 * Event emitted when an agent is invoked.
 */
export interface InvokeEvent extends BaseEvent {
  type: "invoke";
  /** The prompt */
  prompt: string;
  /** Session/branch ID */
  sessionId?: string;
}

/**
 * Event emitted when the `call_agent` MCP tool is invoked.
 * Replaces the legacy `call` event with a namespaced type.
 *
 * Call `next()` to run the default call handler (optionally with a modified request).
 * Call `resolve(response)` to short-circuit with a custom response.
 * If neither is called, the default handler runs.
 *
 * @example
 * ```ts
 * registry.on('tools/call/call_agent', async (event) => {
 *   // Proxy to a remote registry
 *   if (isRemoteAgent(event.request.path)) {
 *     const result = await proxyToRemote(event.request);
 *     event.resolve(result);
 *     return;
 *   }
 *   // Fall through to default handler
 * });
 * ```
 */
export interface CallAgentToolCallEvent extends BaseEvent {
  type: "tools/call/call_agent";
  /** The incoming call_agent request */
  request: CallAgentRequest;
  /** Run the default call handler and return its result.
   *  Optionally pass a modified request to override the original. */
  next(request?: CallAgentRequest): Promise<CallAgentResponse>;
  /** Short-circuit with a response (skips default handler if next() not called) */
  resolve(response: CallAgentResponse): void;
}

/**
 * Result shape for list_agents responses.
 */
export interface ListAgentsResult {
  success: true;
  total: number;
  nextCursor?: string;
  agents: Array<{
    path: string;
    name?: string;
    description?: string;
    supportedActions?: string[];
    integration?: unknown;
    security?: { type: string };
    resources?: Array<{ uri: string; name?: string; mimeType?: string }>;
    tools: string[];
  }>;
}

/**
 * Event emitted when the `list_agents` MCP tool is invoked.
 *
 * Gives hosts a chance to inject additional agents (e.g., from remote registries
 * or consumer config) before BM25 search and pagination run.
 *
 * Call `next(additionalAgents?)` to continue default behavior with optional
 * extra agents merged into the base set.
 * Call `resolve(result)` to short-circuit with a fully formed response.
 * If neither is called, the default handler runs with the base agents.
 *
 * @example
 * ```ts
 * registry.on('tools/call/list_agents', async (event) => {
 *   const remoteAgents = await fetchRemoteAgents();
 *   await event.next(remoteAgents);
 * });
 * ```
 */
export interface ListAgentsToolCallEvent extends BaseEvent {
  type: "tools/call/list_agents";
  /** Agents from the local registry (before search/pagination) */
  baseAgents: AgentDefinition[];
  /** Search query, if provided */
  query?: string;
  /** Requested page size */
  limit?: number;
  /** Pagination cursor */
  cursor?: string;
  /** Continue with default BM25/pagination behavior.
   *  Pass additional agents to merge into the base set. */
  next(additionalAgents?: AgentDefinition[]): Promise<ListAgentsResult>;
  /** Short-circuit with a complete response (same shape as list_agents output) */
  resolve(result: ListAgentsResult): void;
}

/**
 * Union of all built-in event types.
 */
export type AgentEvent =
  | ToolCallEvent
  | ToolResultEvent
  | ToolErrorEvent
  | StepEvent
  | InvokeEvent
  | CallAgentToolCallEvent
  | ListAgentsToolCallEvent;

/**
 * Map from system event type string to event interface.
 */
export interface SystemEventMap {
  "tool/call": ToolCallEvent;
  "tool/result": ToolResultEvent;
  "tool/error": ToolErrorEvent;
  step: StepEvent;
  invoke: InvokeEvent;
  "tools/call/call_agent": CallAgentToolCallEvent;
  "tools/call/list_agents": ListAgentsToolCallEvent;
}

/**
 * Map from event type string to event interface.
 * Combines system events with custom events.
 */
export interface EventMap extends SystemEventMap, CustomEventMap {}

/**
 * Callback for a specific event type.
 */
export type EventCallback<T extends EventType = EventType> = (
  event: T extends keyof EventMap ? EventMap[T] : BaseEvent,
) => void | Promise<void>;

// =============================================================================
// Event Bus
// =============================================================================

/**
 * Listener entry — callback + optional scope for agent/tool filtering.
 */
export interface ListenerEntry {
  eventType: EventType;
  callback: EventCallback<EventType>;
  /** If set, only fire for events matching this agent path */
  agentScope?: string;
  /** If set, only fire for tool events matching this tool name */
  toolScope?: string;
}

export interface EventBus {
  /**
   * Register a listener for an event type.
   *
   * @example
   * ```ts
   * bus.on('tool/result', (event) => { ... })
   * ```
   */
  on<T extends EventType>(eventType: T, callback: EventCallback<T>): void;

  /**
   * Emit an event to all matching listeners.
   * Listeners are called in registration order.
   * Errors in listeners are caught and logged, never propagated.
   */
  emit(event: AgentEvent | (BaseEvent & { type: string })): Promise<void>;

  /**
   * Register a scoped listener (used internally by agent.on / tool.on).
   */
  _onScoped<T extends EventType>(
    eventType: T,
    callback: EventCallback<T>,
    scope: { agentPath?: string; toolName?: string },
  ): void;
}

/**
 * Create an event bus.
 */
export function createEventBus(): EventBus {
  const listeners: ListenerEntry[] = [];

  function on<T extends EventType>(
    eventType: T,
    callback: EventCallback<T>,
  ): void {
    listeners.push({
      eventType,
      callback: callback as EventCallback<EventType>,
    });
  }

  function _onScoped<T extends EventType>(
    eventType: T,
    callback: EventCallback<T>,
    scope: { agentPath?: string; toolName?: string },
  ): void {
    listeners.push({
      eventType,
      callback: callback as EventCallback<EventType>,
      agentScope: scope.agentPath,
      toolScope: scope.toolName,
    });
  }

  async function emit(
    event: AgentEvent | (BaseEvent & { type: string }),
  ): Promise<void> {
    for (const listener of listeners) {
      // Match event type
      if (listener.eventType !== event.type) continue;

      // Match agent scope
      if (listener.agentScope && listener.agentScope !== event.agentPath) {
        continue;
      }

      // Match tool scope (only for tool:* events)
      if (
        listener.toolScope &&
        "tool" in event &&
        listener.toolScope !== event.tool
      ) {
        continue;
      }

      try {
        await listener.callback(event as never);
      } catch (err) {
        // Never propagate listener errors — log and continue
        console.error(
          `[agents-sdk] Event listener error for ${event.type}:`,
          err,
        );
      }
    }
  }

  return { on, emit, _onScoped };
}
