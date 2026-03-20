/**
 * Agent Registry Implementation
 *
 * Manages registered agents and handles callAgent requests.
 */

import type {
  AgentAction,
  AgentDefinition,
  CallAgentDescribeToolsResponse,
  CallAgentErrorResponse,
  CallAgentExecuteToolResponse,
  CallAgentLearnResponse,
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
 * Options for creating an agent registry.
 */
export interface AgentRegistryOptions {
  /** Default visibility for agents without explicit visibility */
  defaultVisibility?: Visibility;
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
export function createAgentRegistry(
  options: AgentRegistryOptions = {},
): AgentRegistry {
  const { defaultVisibility = "internal" } = options;
  const agents = new Map<string, AgentDefinition>();

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
      case "private":
        return callerId === agent.path;
      default:
        return false;
    }
  }

  const registry: AgentRegistry = {
    register(agent: AgentDefinition): void {
      agents.set(agent.path, agent);
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
              error: `Access denied to tool: ${request.tool}`,
              code: "ACCESS_DENIED",
            } as CallAgentErrorResponse;
          }

          const ctx: ToolContext = {
            tenantId: "default",
            agentPath: agent.path,
            callerId: request.callerId ?? "unknown",
            callerType: request.callerType ?? "system",
            metadata: request.metadata,
          };

          try {
            if (!tool.execute) {
              return {
                success: false,
                error: `Tool ${request.tool} has no execute function`,
              } as CallAgentErrorResponse;
            }
            const result = await tool.execute(request.params, ctx);
            return {
              success: true,
              result,
            } as CallAgentExecuteToolResponse;
          } catch (err) {
            return {
              success: false,
              error: err instanceof Error ? err.message : String(err),
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
          const toolSchemas: ToolSchema[] = agent.tools
            .filter((t: ToolDefinition) =>
              checkToolAccess(
                agent,
                t.name,
                request.callerId,
                request.callerType,
              ),
            )
            .map((t: ToolDefinition) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.outputSchema && { outputSchema: t.outputSchema }),
            }));

          return {
            success: true,
            result: {
              path: agent.path,
              entrypoint: agent.entrypoint,
              config: agent.config,
              tools: toolSchemas,
            },
          } as CallAgentLoadResponse;
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
