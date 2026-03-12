/**
 * Define Agent and Tool Functions
 *
 * Factory functions for creating agent and tool definitions.
 */

import type {
  AgentConfig,
  AgentDefinition,
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

  /** Visibility level */
  visibility?: Visibility;

  /** Explicit allowed callers */
  allowedCallers?: string[];
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
 *   tools: [greet, echo]
 * });
 * ```
 */
export function defineAgent<TContext extends ToolContext = ToolContext>(
  options: DefineAgentOptions<TContext>,
): AgentDefinition<TContext> {
  return {
    path: options.path,
    entrypoint: options.entrypoint,
    config: options.config,
    tools: options.tools ?? [],
    visibility: options.visibility,
    allowedCallers: options.allowedCallers,
  };
}
