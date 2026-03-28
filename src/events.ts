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

// =============================================================================
// Event Types
// =============================================================================

/**
 * All supported event types.
 */
export type EventType =
  | "tool:call"
  | "tool:result"
  | "tool:error"
  | "step"
  | "invoke";

/**
 * Base event shape — every event has these fields.
 */
export interface BaseEvent {
  /** Event type */
  type: EventType;
  /** Agent path (e.g., '/agents/atlas-slack') */
  agentPath: string;
  /** Timestamp */
  timestamp: number;
}

/**
 * Event emitted before a tool executes.
 */
export interface ToolCallEvent extends BaseEvent {
  type: "tool:call";
  /** Tool name */
  tool: string;
  /** Input parameters */
  params: unknown;
}

/**
 * Event emitted after a tool succeeds.
 */
export interface ToolResultEvent extends BaseEvent {
  type: "tool:result";
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
  type: "tool:error";
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
 * Union of all event types.
 */
export type AgentEvent =
  | ToolCallEvent
  | ToolResultEvent
  | ToolErrorEvent
  | StepEvent
  | InvokeEvent;

/**
 * Map from event type string to event interface.
 */
export interface EventMap {
  "tool:call": ToolCallEvent;
  "tool:result": ToolResultEvent;
  "tool:error": ToolErrorEvent;
  step: StepEvent;
  invoke: InvokeEvent;
}

/**
 * Callback for a specific event type.
 */
export type EventCallback<T extends EventType = EventType> = (
  event: EventMap[T],
) => void | Promise<void>;

// =============================================================================
// Event Bus
// =============================================================================

/**
 * Listener entry — callback + optional scope for agent/tool filtering.
 */
interface ListenerEntry {
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
   * bus.on('tool:result', (event) => { ... })
   * ```
   */
  on<T extends EventType>(eventType: T, callback: EventCallback<T>): void;

  /**
   * Emit an event to all matching listeners.
   * Listeners are called in registration order.
   * Errors in listeners are caught and logged, never propagated.
   */
  emit(event: AgentEvent): Promise<void>;

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

  async function emit(event: AgentEvent): Promise<void> {
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
        await listener.callback(event);
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
