/**
 * ADK Tools — expose an Adk instance as MCP ToolDefinitions.
 *
 * Used by atlas-environments (@config agent) and atlas-runtime
 * to register adk ref/registry operations as MCP tools.
 *
 * @example
 * ```typescript
 * // Standalone — no scopes
 * const tools = createAdkTools({ resolveScope: () => adk });
 *
 * // Atlas — user/tenant scopes
 * const tools = createAdkTools({
 *   resolveScope: (scope) => scope === 'tenant' ? tenantAdk : userAdk,
 *   scopes: ['user', 'tenant'],
 * });
 * ```
 */

import { defineTool } from "./define.js";
import type { ToolDefinition, ToolContext } from "./types.js";
import type { Adk } from "./config-store.js";
import type { RefEntry, RegistryEntry } from "./define-config.js";

export interface CreateAdkToolsOptions<TCtx extends ToolContext = ToolContext> {
  /**
   * Resolve an Adk instance from the scope string and tool context.
   * Called per-operation. TCtx is your environment's context type.
   */
  resolveScope: (scope: string | undefined, ctx: TCtx) => Adk | Promise<Adk>;
  /** Allowed scope values. If set, added as enum to the JSON schema. */
  scopes?: string[];
}

export function createAdkTools<TCtx extends ToolContext = ToolContext>(opts: CreateAdkToolsOptions<TCtx>): ToolDefinition<TCtx>[] {
  const { resolveScope, scopes } = opts;

  const scopeSchema = scopes
    ? { type: "string" as const, enum: scopes, description: "Config scope to operate on" }
    : { type: "string" as const, description: "Config scope (optional)" };

  const refTool = defineTool({
    name: "ref",
    description:
      "Manage agent refs. Operations: add, remove, list, get, update, inspect, call, auth, auth-status, resources, read.",
    inputSchema: {
      type: "object" as const,
      properties: {
        operation: {
          type: "string",
          enum: ["add", "remove", "list", "get", "update", "inspect", "call", "auth", "auth-status", "resources", "read"],
        },
        scope: scopeSchema,
        ref: { type: "string" },
        name: { type: "string" },
        scheme: { type: "string" },
        url: { type: "string" },
        as: { type: "string" },
        sourceRegistry: { type: "object", properties: { url: { type: "string" }, agentPath: { type: "string" } } },
        config: { type: "object" },
        tool: { type: "string" },
        params: { type: "object" },
        full: { type: "boolean" },
        uris: { type: "array", items: { type: "string" } },
        apiKey: { type: "string" },
      },
      required: ["operation"],
    },
    execute: async (input: Record<string, unknown>, ctx) => {
      const adk = await resolveScope(input.scope as string | undefined, ctx as TCtx);
      const op = input.operation as string;

      switch (op) {
        case "add": {
          const entry: Record<string, unknown> = { ref: input.ref };
          if (input.scheme) entry.scheme = input.scheme;
          if (input.url) entry.url = input.url;
          if (input.as) entry.as = input.as;
          if (input.sourceRegistry) entry.sourceRegistry = input.sourceRegistry;
          if (input.config) entry.config = input.config;
          return adk.ref.add(entry as unknown as RefEntry);
        }
        case "remove":
          return { removed: await adk.ref.remove(input.name as string) };
        case "list":
          return { refs: await adk.ref.list() };
        case "get":
          return await adk.ref.get(input.name as string);
        case "update":
          return { updated: await adk.ref.update(input.name as string, input as unknown as Partial<RefEntry>) };
        case "inspect":
          return await adk.ref.inspect(input.name as string, { full: input.full as boolean });
        case "call":
          return await adk.ref.call(input.name as string, input.tool as string, input.params as Record<string, unknown>);
        case "auth":
          return await adk.ref.auth(input.name as string, { apiKey: input.apiKey as string });
        case "auth-status":
          return await adk.ref.authStatus(input.name as string);
        case "resources":
          return await adk.ref.resources(input.name as string);
        case "read":
          return await adk.ref.read(input.name as string, input.uris as string[]);
        default:
          throw new Error(`Unknown ref operation: ${op}`);
      }
    },
  }) as ToolDefinition<TCtx>;

  const registryTool = defineTool({
    name: "registry",
    description:
      "Manage registry connections. Operations: add, remove, list, browse, inspect, test.",
    inputSchema: {
      type: "object" as const,
      properties: {
        operation: {
          type: "string",
          enum: ["add", "remove", "list", "browse", "inspect", "test"],
        },
        scope: scopeSchema,
        url: { type: "string" },
        name: { type: "string" },
        query: { type: "string" },
        auth: { type: "object" },
      },
      required: ["operation"],
    },
    execute: async (input: Record<string, unknown>, ctx) => {
      const adk = await resolveScope(input.scope as string | undefined, ctx as TCtx);
      const op = input.operation as string;

      switch (op) {
        case "add": {
          const entry: Record<string, unknown> = { url: input.url, name: input.name };
          if (input.auth) entry.auth = input.auth;
          await adk.registry.add(entry as unknown as RegistryEntry);
          return { added: true, name: input.name, url: input.url };
        }
        case "remove":
          return { removed: await adk.registry.remove(input.name as string) };
        case "list":
          return { registries: await adk.registry.list() };
        case "browse":
          return { agents: await adk.registry.browse(input.name as string, input.query as string) };
        case "inspect":
          return await adk.registry.inspect(input.name as string);
        case "test":
          return { results: await adk.registry.test(input.name as string) };
        default:
          throw new Error(`Unknown registry operation: ${op}`);
      }
    },
  });

  return [refTool, registryTool as unknown as ToolDefinition<TCtx>];
}
