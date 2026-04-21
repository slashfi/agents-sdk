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

import type { Adk } from "./config-store.js";
import type { RefEntry, RegistryEntry } from "./define-config.js";
import { defineTool } from "./define.js";
import type { ToolContext, ToolDefinition } from "./types.js";

export interface AdkToolsHooks<TCtx extends ToolContext = ToolContext> {
  /**
   * Return extra context to embed in the OAuth state parameter.
   * Typically used to include tenant/user IDs so the callback handler
   * can resolve the right VCS scope.
   *
   * @example
   * ```ts
   * getAuthStateContext: async (ctx) => ({ tid: ctx.tenantId, uid: ctx.userId })
   * ```
   */
  getAuthStateContext?: (
    ctx: TCtx,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface CreateAdkToolsOptions<TCtx extends ToolContext = ToolContext> {
  /**
   * Resolve an Adk instance from the scope string and tool context.
   * Called per-operation. TCtx is your environment's context type.
   */
  resolveScope: (scope: string | undefined, ctx: TCtx) => Adk | Promise<Adk>;
  /** Allowed scope values. If set, added as enum to the JSON schema. */
  scopes?: string[];
  /** Optional hooks to augment tool behavior with caller-specific context. */
  hooks?: AdkToolsHooks<TCtx>;
}

export function createAdkTools<TCtx extends ToolContext = ToolContext>(
  opts: CreateAdkToolsOptions<TCtx>,
): ToolDefinition<TCtx>[] {
  const { resolveScope, scopes } = opts;

  const scopeSchema = scopes
    ? {
        type: "string" as const,
        enum: scopes,
        description: "Config scope to operate on",
      }
    : { type: "string" as const, description: "Config scope (optional)" };

  const refTool = defineTool({
    name: "ref",
    description:
      "Manage agent refs. Operations: add, remove, list, update, inspect, call, auth, auth-status, refresh-token, resources, read. For `add`, supply `ref` (canonical agent path, e.g. 'notion') and optionally `name` for a local alias; either one uniquely identifies the ref. For every other operation, pass `name` (the local identifier you used on add — defaults to `ref` when you didn't set it explicitly).",
    inputSchema: {
      type: "object" as const,
      properties: {
        operation: {
          type: "string",
          enum: [
            "add",
            "remove",
            "list",
            "update",
            "inspect",
            "call",
            "auth",
            "auth-status",
            "refresh-token",
            "resources",
            "read",
          ],
        },
        scope: scopeSchema,
        ref: {
          type: "string",
          description:
            "Canonical agent path on the remote registry (e.g. 'notion', 'linear', 'github'). Used by `add` to identify which agent definition to connect to. Other operations use `name` instead. If you call `add` with only `name` and no `ref`, `ref` defaults to `name`.",
        },
        name: {
          type: "string",
          description:
            "Local identifier for this ref, used by all operations except `add` to look up the entry. On `add`, `name` is optional — it only needs to differ from `ref` when you want multiple local instances of the same agent (e.g. `{ ref: 'notion', name: 'work-notion' }`). Omit it and the ref is identified by its canonical path.",
        },
        scheme: {
          type: "string",
          description:
            "Connection scheme: 'mcp' (direct MCP server), 'https' (REST proxy), or 'registry' (discovered via a registry). Auto-inferred from `url` or `sourceRegistry` when omitted.",
        },
        url: {
          type: "string",
          description:
            "Direct URL to the agent (e.g. https://mcp.notion.com/mcp). Required for 'mcp' and 'https' schemes.",
        },
        sourceRegistry: {
          type: "object",
          properties: {
            url: { type: "string" },
            agentPath: { type: "string" },
          },
          description:
            "When scheme is 'registry', the registry + agent path to resolve through.",
        },
        config: {
          type: "object",
          description:
            "Per-instance config passed to the agent (headers, credentials, etc.). Supports `{{secret-uri}}` templates.",
        },
        tool: {
          type: "string",
          description:
            "For `call` operation: the tool name on the ref to invoke.",
        },
        params: {
          type: "object",
          description: "For `call` operation: arguments to pass to the tool.",
        },
        full: {
          type: "boolean",
          description:
            "For `inspect` operation: include full agent definition.",
        },
        uris: {
          type: "array",
          items: { type: "string" },
          description: "For `read` operation: the resource URIs to read.",
        },
        apiKey: {
          type: "string",
          description: "For `auth` operation: pre-provisioned API key.",
        },
        credentials: {
          type: "object",
          description:
            "For `auth` operation: key-value map of credential fields (keys match field names from the auth challenge).",
        },
      },
      required: ["operation"],
    },
    execute: async (input: Record<string, unknown>, ctx) => {
      const adk = await resolveScope(
        input.scope as string | undefined,
        ctx as TCtx,
      );
      const op = input.operation as string;

      switch (op) {
        case "add": {
          // Accept `ref` or `name` (or both). If only one is given, the
          // other defaults to it. This matches the "Add a ref called X"
          // natural-language phrasing — LLMs that pick `name` get the
          // same behavior as ones that pick `ref`, eliminating
          // non-determinism on the identifier field. Throws when both
          // are missing, so misuse is loud instead of silently storing
          // `{ ref: undefined }`.
          const refValue = (input.ref ?? input.name) as string | undefined;
          if (!refValue) {
            throw new Error(
              "ref.add: must supply either 'ref' (canonical agent path) or 'name' (local identifier); both may be the same string for the common single-instance case.",
            );
          }
          const entry: Record<string, unknown> = { ref: refValue };
          if (input.scheme) entry.scheme = input.scheme;
          if (input.url) entry.url = input.url;
          // Only store `name` when it's meaningfully different from
          // `ref` (the multi-instance aliasing case). Avoids a
          // redundant `{ name: 'notion', ref: 'notion' }` stored shape.
          const nameValue = input.name as string | undefined;
          if (nameValue && nameValue !== refValue) {
            entry.name = nameValue;
          }
          if (input.sourceRegistry) entry.sourceRegistry = input.sourceRegistry;
          if (input.config) entry.config = input.config;
          const { security } = await adk.ref.add(entry as unknown as RefEntry);
          return {
            added: true,
            ref: refValue,
            name: (entry.name ?? refValue) as string,
            security,
          };
        }
        case "remove":
          return { removed: await adk.ref.remove(input.name as string) };
        case "list":
          return { refs: await adk.ref.list() };
        case "update":
          return {
            updated: await adk.ref.update(
              input.name as string,
              input as unknown as Partial<RefEntry>,
            ),
          };
        case "inspect":
          return await adk.ref.inspect(input.name as string, {
            full: input.full as boolean,
          });
        case "call":
          return await adk.ref.call(
            input.name as string,
            input.tool as string,
            input.params as Record<string, unknown>,
          );
        case "auth": {
          const authOpts: {
            apiKey?: string;
            credentials?: Record<string, string>;
            stateContext?: Record<string, unknown>;
          } = {};
          if (input.apiKey) authOpts.apiKey = input.apiKey as string;
          if (input.credentials)
            authOpts.credentials = input.credentials as Record<string, string>;
          if (opts.hooks?.getAuthStateContext) {
            authOpts.stateContext = await opts.hooks.getAuthStateContext(
              ctx as TCtx,
            );
          }
          return await adk.ref.auth(input.name as string, authOpts);
        }
        case "auth-status":
          return await adk.ref.authStatus(input.name as string);
        case "refresh-token":
          return await adk.ref.refreshToken(input.name as string);
        case "resources":
          return await adk.ref.resources(input.name as string);
        case "read":
          return await adk.ref.read(
            input.name as string,
            input.uris as string[],
          );
        default:
          throw new Error(`Unknown ref operation: ${op}`);
      }
    },
  }) as ToolDefinition<TCtx>;

  const registryTool = defineTool({
    name: "registry",
    description:
      "Manage registry connections. Operations: add, remove, list, update, browse, inspect, test.",
    inputSchema: {
      type: "object" as const,
      properties: {
        operation: {
          type: "string",
          enum: [
            "add",
            "remove",
            "list",
            "update",
            "browse",
            "inspect",
            "test",
          ],
        },
        scope: scopeSchema,
        url: { type: "string" },
        name: { type: "string" },
        query: { type: "string" },
        auth: { type: "object" },
        headers: { type: "object" },
      },
      required: ["operation"],
    },
    execute: async (input: Record<string, unknown>, ctx) => {
      const adk = await resolveScope(
        input.scope as string | undefined,
        ctx as TCtx,
      );
      const op = input.operation as string;

      switch (op) {
        case "add": {
          const entry: Record<string, unknown> = {
            url: input.url,
            name: input.name,
          };
          if (input.auth) entry.auth = input.auth;
          if (input.headers) entry.headers = input.headers;
          await adk.registry.add(entry as unknown as RegistryEntry);
          return { added: true, name: input.name, url: input.url };
        }
        case "remove":
          return { removed: await adk.registry.remove(input.name as string) };
        case "list":
          return { registries: await adk.registry.list() };
        case "update": {
          const updates: Record<string, unknown> = {};
          if (input.url) updates.url = input.url;
          if (input.name !== undefined) updates.name = input.name;
          if (input.auth) updates.auth = input.auth;
          if (input.headers) updates.headers = input.headers;
          return {
            updated: await adk.registry.update(
              input.name as string,
              updates as unknown as Partial<RegistryEntry>,
            ),
          };
        }
        case "browse":
          return {
            agents: await adk.registry.browse(
              input.name as string,
              input.query as string,
            ),
          };
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
