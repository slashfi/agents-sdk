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

import { z } from "zod";
import { AdkError } from "./adk-error.js";
import { zodToOpenAiJsonSchema } from "./call-agent-schema.js";
import type { Adk } from "./config-store.js";
import type { RefEntry, RegistryEntry } from "./define-config.js";
import { defineTool } from "./define.js";
import type { JsonSchema, ToolContext, ToolDefinition } from "./types.js";

const objectRecordSchema = z.record(z.unknown());
const sourceRegistrySchema = z
  .object({
    url: z.string().min(1).describe("Registry MCP URL."),
    agentPath: z.string().optional().describe("Agent path on that registry."),
  })
  .passthrough();
const refScopeSchema = z
  .string()
  .optional()
  .describe("Config scope to operate on.");
const refNameSchema = z.string().min(1).describe("Local connection name.");

const refAddOperationSchema = z
  .object({
    operation: z.literal("add"),
    scope: refScopeSchema,
    ref: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Canonical agent path, e.g. 'google-calendar'. Defaults to name when omitted.",
      ),
    name: refNameSchema
      .optional()
      .describe("Local connection name. Defaults to ref when omitted."),
    scheme: z
      .enum(["registry", "mcp", "https"])
      .optional()
      .describe(
        "Connection type. Usually inferred from sourceRegistry or url.",
      ),
    url: z
      .string()
      .min(1)
      .optional()
      .describe("Direct MCP/HTTPS URL. Required for direct mcp/https refs."),
    sourceRegistry: sourceRegistrySchema
      .optional()
      .describe(
        "Registry that serves this agent. Required for registry-backed refs.",
      ),
    config: objectRecordSchema
      .optional()
      .describe("Optional per-instance config."),
  })
  .passthrough()
  .superRefine((input, ctx) => {
    if (!input.ref && !input.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ref"],
        message: "Either ref or name is required.",
      });
    }
    if (input.scheme === "registry" && !input.sourceRegistry?.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceRegistry", "url"],
        message: "scheme=registry requires sourceRegistry.url.",
      });
    }
    if ((input.scheme === "mcp" || input.scheme === "https") && !input.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: `scheme=${input.scheme} requires url.`,
      });
    }
    if (!input.url && !input.sourceRegistry?.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceRegistry"],
        message:
          "Connection target is required: provide sourceRegistry.url for a registry ref, or url for a direct mcp/https ref.",
      });
    }
  });

const refOperationSchemas = {
  add: refAddOperationSchema,
  remove: z
    .object({
      operation: z.literal("remove"),
      scope: refScopeSchema,
      name: refNameSchema,
    })
    .passthrough(),
  list: z
    .object({ operation: z.literal("list"), scope: refScopeSchema })
    .passthrough(),
  update: z
    .object({
      operation: z.literal("update"),
      scope: refScopeSchema,
      name: refNameSchema,
      ref: z.string().optional(),
      scheme: z.enum(["registry", "mcp", "https"]).optional(),
      url: z.string().optional(),
      sourceRegistry: sourceRegistrySchema.optional(),
      config: objectRecordSchema.optional(),
    })
    .passthrough(),
  inspect: z
    .object({
      operation: z.literal("inspect"),
      scope: refScopeSchema,
      name: refNameSchema,
      full: z.boolean().optional(),
    })
    .passthrough(),
  call: z
    .object({
      operation: z.literal("call"),
      scope: refScopeSchema,
      name: refNameSchema,
      tool: z.string().min(1),
      params: objectRecordSchema.optional(),
    })
    .passthrough(),
  auth: z
    .object({
      operation: z.literal("auth"),
      scope: refScopeSchema,
      name: refNameSchema,
      ref: z.string().optional(),
      apiKey: z.string().optional(),
      credentials: z.record(z.string()).optional(),
      sourceRegistry: sourceRegistrySchema.optional(),
    })
    .passthrough(),
  "auth-status": z
    .object({
      operation: z.literal("auth-status"),
      scope: refScopeSchema,
      name: refNameSchema,
    })
    .passthrough(),
  "refresh-token": z
    .object({
      operation: z.literal("refresh-token"),
      scope: refScopeSchema,
      name: refNameSchema,
    })
    .passthrough(),
  resources: z
    .object({
      operation: z.literal("resources"),
      scope: refScopeSchema,
      name: refNameSchema,
    })
    .passthrough(),
  read: z
    .object({
      operation: z.literal("read"),
      scope: refScopeSchema,
      name: refNameSchema,
      uris: z.array(z.string()),
    })
    .passthrough(),
} as const;

const refToolInputSchema = z.union([
  refOperationSchemas.add,
  refOperationSchemas.remove,
  refOperationSchemas.list,
  refOperationSchemas.update,
  refOperationSchemas.inspect,
  refOperationSchemas.call,
  refOperationSchemas.auth,
  refOperationSchemas["auth-status"],
  refOperationSchemas["refresh-token"],
  refOperationSchemas.resources,
  refOperationSchemas.read,
]);
const refToolInputJsonSchema = zodToOpenAiJsonSchema(
  refToolInputSchema,
) as JsonSchema;

function parseRefToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const op = typeof input.operation === "string" ? input.operation : undefined;
  const schema =
    op && op in refOperationSchemas
      ? refOperationSchemas[op as keyof typeof refOperationSchemas]
      : refToolInputSchema;
  const result = schema.safeParse(input);
  if (result.success) return result.data as Record<string, unknown>;

  const operation = op ? `ref.${op}` : "ref";
  throw new AdkError({
    code: "TOOL_INPUT_INVALID",
    message: `Invalid ${operation} input`,
    hint: "The expected input schema is serialized in details.schema; operation-specific schema is in details.operationSchema.",
    details: {
      operation,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
      received: input,
      schema: refToolInputJsonSchema,
      ...(op &&
        op in refOperationSchemas && {
          operationSchema: zodToOpenAiJsonSchema(
            refOperationSchemas[op as keyof typeof refOperationSchemas],
          ),
        }),
    },
  });
}

function withScopeSchema(
  schema: JsonSchema,
  scopeSchema: JsonSchema,
): JsonSchema {
  const clone = JSON.parse(JSON.stringify(schema)) as JsonSchema;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const record = value as Record<string, unknown>;
    const properties = record.properties as Record<string, unknown> | undefined;
    if (properties?.scope) {
      properties.scope = scopeSchema;
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };
  visit(clone);
  return clone;
}

export interface AdkToolsHooks<TCtx extends ToolContext = ToolContext> {
  /**
   * Return extra context to embed in the OAuth state parameter.
   * Typically used to include tenant/user IDs so the callback handler
   * can resolve the right VCS scope.
   *
   * @example
   * ```ts
   * getAuthStateContext: async (input, ctx) => ({ tid: ctx.tenantId, uid: ctx.userId, name: input.name })
   * ```
   */
  getAuthStateContext?: (
    input: Record<string, unknown>,
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
      "Manage agent refs. Operations: add, remove, list, update, inspect, call, auth, auth-status, refresh-token, resources, read. For `add`, supply `ref` (canonical agent path, e.g. 'notion') and `name` (local identifier). If `name` is omitted on add, it defaults to `ref`. For every other operation, pass `name`.",
    inputSchema: withScopeSchema(refToolInputJsonSchema, scopeSchema),
    execute: async (input: Record<string, unknown>, ctx) => {
      const parsedInput = parseRefToolInput(input);
      const adk = await resolveScope(
        parsedInput.scope as string | undefined,
        ctx as TCtx,
      );
      const op = parsedInput.operation as string;

      switch (op) {
        case "add": {
          // Accept `ref` or `name` (or both). If only one is given, the
          // other defaults to it. The stored entry always has an explicit
          // `name`, so downstream auth/callback state can distinguish the
          // canonical ref from the local connection handle.
          const refValue = (parsedInput.ref ?? parsedInput.name) as
            | string
            | undefined;
          if (!refValue) {
            throw new Error(
              "ref.add: must supply either 'ref' (canonical agent path) or 'name' (local identifier); both may be the same string for the common single-instance case.",
            );
          }
          const nameValue = (parsedInput.name ?? refValue) as string;
          const entry: Record<string, unknown> = {
            ref: refValue,
            name: nameValue,
          };
          if (parsedInput.scheme) entry.scheme = parsedInput.scheme;
          if (parsedInput.url) entry.url = parsedInput.url;
          if (parsedInput.sourceRegistry)
            entry.sourceRegistry = parsedInput.sourceRegistry;
          if (parsedInput.config) entry.config = parsedInput.config;
          const { security } = await adk.ref.add(entry as unknown as RefEntry);
          return {
            added: true,
            ref: refValue,
            name: nameValue,
            security,
          };
        }
        case "remove":
          return { removed: await adk.ref.remove(parsedInput.name as string) };
        case "list":
          return { refs: await adk.ref.list() };
        case "update":
          return {
            updated: await adk.ref.update(
              parsedInput.name as string,
              parsedInput as unknown as Partial<RefEntry>,
            ),
          };
        case "inspect":
          return await adk.ref.inspect(parsedInput.name as string, {
            full: parsedInput.full as boolean,
          });
        case "call":
          return await adk.ref.call(
            parsedInput.name as string,
            parsedInput.tool as string,
            parsedInput.params as Record<string, unknown>,
          );
        case "auth": {
          const authOpts: {
            apiKey?: string;
            credentials?: Record<string, string>;
            stateContext?: Record<string, unknown>;
          } = {};
          if (parsedInput.apiKey)
            authOpts.apiKey = parsedInput.apiKey as string;
          if (parsedInput.credentials)
            authOpts.credentials = parsedInput.credentials as Record<
              string,
              string
            >;
          if (opts.hooks?.getAuthStateContext) {
            authOpts.stateContext = await opts.hooks.getAuthStateContext(
              parsedInput,
              ctx as TCtx,
            );
          }
          return await adk.ref.auth(parsedInput.name as string, authOpts);
        }
        case "auth-status":
          return await adk.ref.authStatus(parsedInput.name as string);
        case "refresh-token":
          return await adk.ref.refreshToken(parsedInput.name as string);
        case "resources":
          return await adk.ref.resources(parsedInput.name as string);
        case "read":
          return await adk.ref.read(
            parsedInput.name as string,
            parsedInput.uris as string[],
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
