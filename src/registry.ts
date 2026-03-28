/**
 * Agent Registry Implementation
 *
 * Manages registered agents and handles callAgent requests.
 */

import { dirname, resolve } from "node:path";
import type {
  AgentEvent,
  EventCallback,
  EventType,
} from "./events.js";
import { createEventBus } from "./events.js";
import type {
  AgentAction,
  AgentDefinition,
  AgentRefEntry,
  CallAgentDescribeToolsResponse,
  CallAgentErrorResponse,
  CallAgentExecuteToolResponse,
  CallAgentLearnResponse,
  CallAgentLoadRequest,
  CallAgentLoadResponse,
  CallAgentRequest,
  CallAgentResponse,
  ToolContext,
  ToolDefinition,
  ToolSchema,
  Visibility,
} from "./types.js";

/** Default supported actions if not specified */
const DEFAULT_SUPPORTED_ACTIONS: AgentAction[] = [
  "execute_tool",
  "describe_tools",
  "load",
];

// ============================================
// Agent Registry Interface
// ============================================

/**
 * Middleware hooks for registry lifecycle actions.
 * Each hook receives the default handler fn and context,
 * giving full control: call default, skip it, try/catch, or enhance.
 */
export interface RegistryMiddleware {
  load?: (
    defaultFn: (agent: AgentDefinition, request: CallAgentLoadRequest) => Promise<CallAgentLoadResponse>,
    ctx: { agent: AgentDefinition; request: CallAgentLoadRequest; registry: AgentRegistry },
  ) => Promise<CallAgentLoadResponse>;
}

/**
 * Options for creating an agent registry.
 */
export interface AgentRegistryOptions {
  /** Default visibility for agents without explicit visibility */
  defaultVisibility?: Visibility;
  /** Factory to enrich ToolContext with application-specific data */
  contextFactory?: ContextFactory;
  /** Lifecycle middleware hooks */
  middleware?: RegistryMiddleware;
}

/**
 * Agent registry interface.
 */
export interface AgentRegistry {
  /** Register an agent */
  register(agent: AgentDefinition): void;

  /** Get an agent by path */
  get(path: string): AgentDefinition | undefined;

  /** Check if an agent exists */
  has(path: string): boolean;

  /** List all registered agents */
  list(): AgentDefinition[];

  /** List all registered agent paths */
  listPaths(): string[];

  /** Call an agent (execute action) */
  call(request: CallAgentRequest): Promise<CallAgentResponse>;

  /** Register an event listener (global scope — fires for all agents) */
  on<T extends EventType>(eventType: T, callback: EventCallback<T>): void;

  /** Emit an event to all listeners. Used by the runtime to push lifecycle events. */
  emit(event: AgentEvent): Promise<void>;
}

// ============================================
// Create Registry
// ============================================

/**
 * Create an agent registry.
 *
 * @example
 * ```typescript
 * const registry = createAgentRegistry();
 * registry.register(myAgent);
 *
 * const result = await registry.call({
 *   action: 'execute_tool',
 *   path: '@my-agent',
 *   tool: 'greet',
 *   params: { name: 'World' }
 * });
 * ```
 */
/**
 * Factory function that enriches the base ToolContext with application-specific data.
 * Called before every tool execution.
 */
export type ContextFactory = (baseCtx: import("./types.js").ToolContext) => import("./types.js").ToolContext;

export function createAgentRegistry(
  options: AgentRegistryOptions = {},
): AgentRegistry {
  const { defaultVisibility = "internal" } = options;
  const agents = new Map<string, AgentDefinition>();
  const eventBus = createEventBus();

  /**
   * Check if agent supports the requested action.
   */
  function checkActionSupported(
    agent: AgentDefinition,
    action: AgentAction,
  ): boolean {
    const supported =
      agent.config?.supportedActions ?? DEFAULT_SUPPORTED_ACTIONS;
    return supported.includes(action);
  }

  /**
   * Check if caller is allowed to access the agent.
   */
  function checkAgentAccess(
    agent: AgentDefinition,
    callerId?: string,
    callerType?: string,
  ): boolean {
    const visibility = agent.visibility ?? defaultVisibility;

    // System callers can access everything
    if (callerType === "system") return true;

    // Check explicit allowlist first
    if (agent.allowedCallers && callerId) {
      if (agent.allowedCallers.includes(callerId)) return true;
    }

    // Check visibility
    switch (visibility) {
      case "public":
        return true;
      case "internal":
        // Authenticated callers (agents or users with a callerId) can access
        return (
          callerType === "agent" || (callerType != null && callerId != null)
        );
      case "private":
        // Only self can access
        return callerId === agent.path;
      default:
        return false;
    }
  }

  /**
   * Check if caller is allowed to use a tool.
   */
  function checkToolAccess(
    agent: AgentDefinition,
    toolName: string,
    callerId?: string,
    callerType?: string,
  ): boolean {
    const tool = agent.tools.find((t: ToolDefinition) => t.name === toolName);
    if (!tool) return false;

    const visibility = tool.visibility ?? "public";

    // System callers can access everything
    if (callerType === "system") return true;

    // Check explicit allowlist first
    if (tool.allowedCallers && callerId) {
      if (tool.allowedCallers.includes(callerId)) return true;
    }

    // Check visibility
    switch (visibility) {
      case "public":
        return true;
      case "internal":
        return (
          callerType === "agent" || (callerType != null && callerId != null)
        );
      case "authenticated":
        return callerId != null && callerId !== "anonymous";
      case "private":
        return callerId === agent.path;
      default:
        return false;
    }
  }

  function resolveRefPath(currentPath: string, ref: string): string {
    if (ref.startsWith("@") && !ref.includes("/")) {
      return `/agents/${ref}`;
    }
    if (ref.startsWith("../") || ref.startsWith("./")) {
      const dir = dirname(currentPath);
      return resolve(dir, ref);
    }
    if (ref.startsWith("/")) {
      return ref;
    }
    return `/agents/${ref}`;
  }

  function buildToolsSection(
    ownTools: ToolSchema[],
    agentRefs: AgentRefEntry[],
  ): string {
    const hasOwnTools = ownTools.length > 0;
    const hasRefTools = agentRefs.some((ref) => ref.tools.length > 0);
    if (!hasOwnTools && !hasRefTools) return "";

    const lines: string[] = ["\n\n## Available Tools\n"];

    if (hasOwnTools) {
      lines.push("| Tool | Description |", "|------|-------------|");
      for (const t of ownTools) {
        lines.push(`| ${t.name} | ${t.description} |`);
      }
      lines.push("");
    }

    for (const ref of agentRefs) {
      if (ref.tools.length > 0) {
        lines.push(`### From ${ref.key} (${ref.path})\n`);
        lines.push("| Tool | Description |", "|------|-------------|");
        for (const t of ref.tools) {
          lines.push(`| ${t.name} | ${t.description} |`);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  async function defaultLoad(
    agent: AgentDefinition,
    request: CallAgentLoadRequest,
  ): Promise<CallAgentLoadResponse> {
    const toolSchemas: ToolSchema[] = agent.tools
      .filter((t: ToolDefinition) =>
        checkToolAccess(agent, t.name, request.callerId, request.callerType),
      )
      .map((t: ToolDefinition) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.outputSchema && { outputSchema: t.outputSchema }),
      }));

    const agentRefs: AgentRefEntry[] = [];
    const refs = agent.config?.refs;
    if (refs) {
      for (const [key, refConfig] of Object.entries(refs)) {
        const refPath = resolveRefPath(agent.path, key);
        const refAgent = agents.get(refPath);
        const allTools = (refAgent?.tools ?? [])
          .filter((t: ToolDefinition) =>
            checkToolAccess(refAgent!, t.name, request.callerId, request.callerType),
          )
          .map((t: ToolDefinition) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.outputSchema && { outputSchema: t.outputSchema }),
          }));
        const publicFilter = refAgent?.config?.public?.tools;
        const tools = publicFilter
          ? allTools.filter((t) => publicFilter.includes(t.name))
          : allTools;
        agentRefs.push({
          key,
          path: refPath,
          description: refConfig.description ?? key,
          tools,
        });
      }
    }

    const systemPrompt = agent.entrypoint + buildToolsSection(toolSchemas, agentRefs);

    return {
      success: true,
      result: {
        path: agent.path,
        entrypoint: agent.entrypoint,
        systemPrompt,
        contextMessages: [],
        config: agent.config,
        tools: toolSchemas,
        agentRefs,
      },
    };
  }

  const registry: AgentRegistry = {
    register(agent: AgentDefinition): void {
      agents.set(agent.path, agent);

      // Collect agent-level listeners into the bus
      if (agent._listeners) {
        for (const entry of agent._listeners) {
          eventBus._onScoped(entry.eventType, entry.callback, {
            agentPath: agent.path,
            toolName: entry.toolScope,
          });
        }
      }

      // Collect tool-level listeners into the bus
      for (const tool of agent.tools) {
        if (tool._listeners) {
          for (const entry of tool._listeners) {
            eventBus._onScoped(entry.eventType, entry.callback, {
              agentPath: agent.path,
              toolName: tool.name,
            });
          }
        }
      }
    },

    get(path: string): AgentDefinition | undefined {
      return agents.get(path);
    },

    has(path: string): boolean {
      return agents.has(path);
    },

    list(): AgentDefinition[] {
      return Array.from(agents.values());
    },

    listPaths(): string[] {
      return Array.from(agents.keys());
    },

    on<T extends EventType>(eventType: T, callback: EventCallback<T>): void {
      eventBus.on(eventType, callback);
    },

    async emit(event: AgentEvent): Promise<void> {
      await eventBus.emit(event);
    },

    async call(request: CallAgentRequest): Promise<CallAgentResponse> {
      const agent = agents.get(request.path);

      if (!agent) {
        return {
          success: false,
          error: `Agent not found: ${request.path}`,
          code: "AGENT_NOT_FOUND",
        } as CallAgentErrorResponse;
      }

      // Check agent access
      if (!checkAgentAccess(agent, request.callerId, request.callerType)) {
        return {
          success: false,
          error: `Access denied to agent: ${request.path}`,
          code: "ACCESS_DENIED",
        } as CallAgentErrorResponse;
      }

      // Check action is supported
      if (!checkActionSupported(agent, request.action)) {
        const supported =
          agent.config?.supportedActions ?? DEFAULT_SUPPORTED_ACTIONS;
        return {
          success: false,
          error: `Action '${request.action}' not supported by agent. Supported: ${supported.join(", ")}`,
          code: "ACTION_NOT_SUPPORTED",
        } as CallAgentErrorResponse;
      }

      switch (request.action) {
        case "invoke":
        case "ask": {
          // Get runtime if available
          const runtime = agent.runtime?.();

          // Call onInvoke hook if defined
          if (runtime?.onInvoke) {
            await runtime.onInvoke({
              tenantId: "default",
              agentPath: request.path,
              prompt: request.prompt,
              sessionId: request.sessionId,
              callerId: request.callerId ?? "unknown",
              callerType: request.callerType ?? "system",
              metadata: request.metadata,
            });
          }

          // These actions require an LLM runtime which this SDK doesn't provide
          // Users can implement their own invoke/ask handlers or use a full runtime
          return {
            success: false,
            error: `Action '${request.action}' requires an LLM runtime. Use execute_tool for direct tool calls.`,
            code: "RUNTIME_REQUIRED",
          } as CallAgentErrorResponse;
        }

        case "execute_tool": {
          const tool = agent.tools.find(
            (t: ToolDefinition) => t.name === request.tool,
          );

          if (!tool) {
            return {
              success: false,
              error: `Tool not found: ${request.tool}`,
              code: "TOOL_NOT_FOUND",
            } as CallAgentErrorResponse;
          }

          // Check tool access
          if (
            !checkToolAccess(
              agent,
              request.tool,
              request.callerId,
              request.callerType,
            )
          ) {
            return {
              success: false,
              error: `Access denied to tool: ${request.tool} (visibility=${tool.visibility}, callerId=${request.callerId}, callerType=${request.callerType})`,
              code: "ACCESS_DENIED",
            } as CallAgentErrorResponse;
          }

          let ctx: ToolContext = {
            tenantId: "default",
            agentPath: agent.path,
            callerId: request.callerId ?? "unknown",
            callerType: request.callerType ?? "system",
            metadata: request.metadata,
          };

          // Apply contextFactory if provided
          if (options.contextFactory) {
            ctx = options.contextFactory(ctx);
          }

          try {
            if (!tool.execute) {
              return {
                success: false,
                error: `Tool ${request.tool} has no execute function`,
              } as CallAgentErrorResponse;
            }

            // Emit tool/call before execution
            const startMs = Date.now();
            await eventBus.emit({
              type: "tool/call",
              agentPath: agent.path,
              tool: request.tool!,
              params: request.params,
              timestamp: startMs,
            });

            let result: unknown;
            try {
              result = await tool.execute(request.params, ctx);
            } catch (err) {
              // Emit tool/error on failure
              await eventBus.emit({
                type: "tool/error",
                agentPath: agent.path,
                tool: request.tool!,
                params: request.params,
                error: err,
                durationMs: Date.now() - startMs,
                timestamp: Date.now(),
              }).catch(() => {}); // don't let emit error mask tool error

              return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
                code: "TOOL_EXECUTION_ERROR",
              } as CallAgentErrorResponse;
            }

            // Emit tool/result after success
            await eventBus.emit({
              type: "tool/result",
              agentPath: agent.path,
              tool: request.tool!,
              params: request.params,
              result,
              durationMs: Date.now() - startMs,
              timestamp: Date.now(),
            });

            return {
              success: true,
              result,
            } as CallAgentExecuteToolResponse;
          } catch (outerErr) {
            // Catch-all for unexpected errors (e.g., emit failures)
            return {
              success: false,
              error: outerErr instanceof Error ? outerErr.message : String(outerErr),
              code: "TOOL_EXECUTION_ERROR",
            } as CallAgentErrorResponse;
          }
        }

        case "describe_tools": {
          const toolSchemas: ToolSchema[] = agent.tools
            .filter((t: ToolDefinition) =>
              checkToolAccess(
                agent,
                t.name,
                request.callerId,
                request.callerType,
              ),
            )
            .filter((t: ToolDefinition) =>
              request.tools ? request.tools.includes(t.name) : true,
            )
            .map((t: ToolDefinition) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.outputSchema && { outputSchema: t.outputSchema }),
            }));

          return {
            success: true,
            tools: toolSchemas,
          } as CallAgentDescribeToolsResponse;
        }

        case "load": {
          if (options.middleware?.load) {
            return options.middleware.load(defaultLoad, { agent, request, registry });
          }
          return defaultLoad(agent, request);
        }

        case "learn": {
          // Get runtime if available
          const runtime = agent.runtime?.();

          // Call onLearn hook if defined
          if (runtime?.onLearn) {
            await runtime.onLearn({
              tenantId: "default",
              agentPath: request.path,
              content: request.content,
              scope: request.scope ?? "session",
              category: request.category,
              callerId: request.callerId ?? "unknown",
            });

            return {
              success: true,
              action: "stored",
            } as CallAgentLearnResponse;
          }

          // No runtime or no onLearn hook - ignore
          return {
            success: true,
            action: "ignored",
          } as CallAgentLearnResponse;
        }

        default: {
          // TypeScript exhaustiveness check
          const _exhaustive: never = request;
          return {
            success: false,
            error: `Unknown action: ${(_exhaustive as CallAgentRequest).action}`,
            code: "UNKNOWN_ACTION",
          } as CallAgentErrorResponse;
        }
      }
    },
  };

  return registry;
}
