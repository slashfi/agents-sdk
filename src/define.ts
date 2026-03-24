/**
 * Define Agent and Tool Functions
 *
 * Factory functions for creating agent and tool definitions.
 */

import type {
  IntegrationHooks,
  AgentConfig,
  AgentDefinition,
  AgentRuntime,
  JsonSchema,
  ToolContext,
  ToolDefinition,
  Visibility,
} from "./types.js";

// ============================================
// defineTool
// ============================================

export interface DefineToolOptions<
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

  /** JSON Schema for output (optional) */
  outputSchema?: JsonSchema;

  /** Visibility level */
  visibility?: Visibility;

  /** Explicit allowed callers */
  allowedCallers?: string[];

  /** Execute function */
  execute: (input: TInput, ctx: TContext) => Promise<TOutput>;
}

/**
 * Create a tool definition.
 *
 * @example
 * ```typescript
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
 * ```
 */
export function defineTool<
  TContext extends ToolContext = ToolContext,
  TInput = unknown,
  TOutput = unknown,
>(
  options: DefineToolOptions<TContext, TInput, TOutput>,
): ToolDefinition<TContext, TInput, TOutput> {
  return {
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    visibility: options.visibility,
    allowedCallers: options.allowedCallers,
    execute: options.execute,
  };
}

// ============================================
// defineAgent
// ============================================

export interface DefineAgentOptions<
  TContext extends ToolContext = ToolContext,
> {
  /** Agent path (e.g., '@example', '/agents/my-agent') */
  path: string;

  /** System prompt / entrypoint content */
  entrypoint: string;

  /** Agent configuration */
  config?: AgentConfig;

  /** Tools provided by this agent */
  tools?: ToolDefinition<TContext, unknown, unknown>[];

  /**
   * Runtime hooks factory.
   * Called once to create the runtime for this agent.
   */
  runtime?: () => AgentRuntime;

  /** Visibility level */
  visibility?: Visibility;

  /** Explicit allowed callers */
  allowedCallers?: string[];

  /**
   * Integration hooks. When provided, defineAgent auto-generates
   * setup_integration, connect_integration, etc. as tools.
   */
  integration?: IntegrationHooks;

  /**
   * @deprecated Use `integration` instead.
   * Integration method callbacks.
   */
}

/**
 * Create an agent definition.
 *
 * @example
 * ```typescript
 * const agent = defineAgent({
 *   path: '@my-agent',
 *   entrypoint: 'You are a helpful assistant.',
 *   config: {
 *     name: 'My Agent',
 *     description: 'A helpful agent'
 *   },
 *   tools: [greet, echo],
 *   runtime: () => ({
 *     onInvoke: async (ctx) => {
 *       console.log(`Invoked with: ${ctx.prompt}`);
 *     },
 *     onTick: async (ctx) => {
 *       console.log(`Tick at ${ctx.timestamp}`);
 *     }
 *   })
 * });
 * ```
 */
export function defineAgent<TContext extends ToolContext = ToolContext>(
  options: DefineAgentOptions<TContext>,
): AgentDefinition<TContext> {
  const tools = [...(options.tools ?? [])];
  let config = options.config;

  // Auto-generate integration tools from hooks
  if (options.integration) {
    const h = options.integration;

    // Set config.integration metadata if not already set
    if (!config?.integration) {
      config = {
        ...config,
        integration: {
          provider: h.provider,
          displayName: h.displayName,
          icon: h.icon,
          category: h.category,
          description: h.description,
        },
      };
    }

    if (h.setup) {
      const fn = h.setup;
      tools.push(defineTool({
        name: "setup_integration",
        description: `Set up ${h.displayName} integration.`,
        visibility: "public" as const,
        inputSchema: { type: "object" as const, properties: { url: { type: "string" }, name: { type: "string" }, config: { type: "object" } } },
        execute: (input: any, ctx: any) => fn(input, ctx),
      }) as any);
    }
    if (h.connect) {
      const fn = h.connect;
      tools.push(defineTool({
        name: "connect_integration",
        description: `Connect a user to ${h.displayName}.`,
        visibility: "public" as const,
        inputSchema: { type: "object" as const, properties: { registryId: { type: "string" }, oidcUserId: { type: "string" }, redirectUri: { type: "string" } }, required: ["registryId"] as const },
        execute: (input: any, ctx: any) => fn(input, ctx),
      }) as any);
    }
    if (h.discover) {
      const fn = h.discover;
      tools.push(defineTool({
        name: "discover_integrations",
        description: `Discover available ${h.displayName} instances.`,
        visibility: "public" as const,
        inputSchema: { type: "object" as const, properties: { url: { type: "string" } } },
        execute: (input: any, ctx: any) => fn(input, ctx),
      }) as any);
    }
    if (h.list) {
      const fn = h.list;
      tools.push(defineTool({
        name: "list_integrations",
        description: `List connected ${h.displayName} instances.`,
        visibility: "public" as const,
        inputSchema: { type: "object" as const, properties: {} },
        execute: (input: any, ctx: any) => fn(input, ctx),
      }) as any);
    }
    if (h.get) {
      const fn = h.get;
      tools.push(defineTool({
        name: "get_integration",
        description: `Get details of a ${h.displayName} instance.`,
        visibility: "public" as const,
        inputSchema: { type: "object" as const, properties: { registryId: { type: "string" } }, required: ["registryId"] as const },
        execute: (input: any, ctx: any) => fn(input, ctx),
      }) as any);
    }
    if (h.update) {
      const fn = h.update;
      tools.push(defineTool({
        name: "update_integration",
        description: `Update a ${h.displayName} instance.`,
        visibility: "public" as const,
        inputSchema: { type: "object" as const, properties: { registryId: { type: "string" }, name: { type: "string" }, url: { type: "string" } }, required: ["registryId"] as const },
        execute: (input: any, ctx: any) => fn(input, ctx),
      }) as any);
    }
  }


  return {
    path: options.path,
    entrypoint: options.entrypoint,
    config,
    tools,
    runtime: options.runtime,
    visibility: options.visibility,
    allowedCallers: options.allowedCallers,
  };
}
