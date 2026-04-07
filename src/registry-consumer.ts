/**
 * Registry Consumer — Connects to registries and resolves refs.
 *
 * The consumer reads a `ConsumerConfig`, discovers registries via
 * `/.well-known/configuration`, resolves refs to agent definitions,
 * and provides a unified interface for calling tools across all connected agents.
 *
 * @example
 * ```typescript
 * import { createRegistryConsumer, defineConfig } from '@slashfi/agents-sdk';
 *
 * const config = defineConfig({
 *   registries: ['https://registry.slash.com'],
 *   refs: ['notion', { ref: 'postgres', as: 'prod-db', config: { url: '...' } }],
 * });
 *
 * const consumer = await createRegistryConsumer(config);
 *
 * // List all available agents across registries
 * const available = await consumer.list();
 *
 * // List configured refs
 * const refs = consumer.refs();
 *
 * // Call a tool on a ref
 * const result = await consumer.call('notion', 'search', { query: 'meeting notes' });
 *
 * // Resolve secrets in config values
 * const dbUrl = await consumer.resolveSecret('https://twin.slash.com/secrets/crdb-url');
 * ```
 */

import type {
  ConsumerConfig,
  RefConfig,
  ResolvedConfig,
  ResolvedRef,
  ResolvedRegistry,
} from "./define-config.js";
import type { CallAgentRequest } from "./call-agent-schema.js";
import type { SecuritySchemeSummary } from "./types.js";
import {
  isSecretUri,
  normalizeRef,
  normalizeRegistry,
} from "./define-config.js";
// TODO: wire discoverOAuthMetadata from ./mcp-client.js into MCP server auth negotiation

// ============================================
// Registry Type Constants
// ============================================

/** Special registry type: connect directly to an MCP server */
export const REGISTRY_TYPE_MCP = "mcp";
/** Special registry type: raw HTTP/REST API */
export const REGISTRY_TYPE_HTTPS = "https";
/** Built-in registry types that bypass normal registry resolution */
const DIRECT_REGISTRY_TYPES = new Set([REGISTRY_TYPE_MCP, REGISTRY_TYPE_HTTPS]);

/** Regex for {{secret-uri}} template syntax */
const TEMPLATE_REGEX = /\{\{(.+?)\}\}/g;

/** Check if a string contains {{...}} template expressions */
function hasTemplates(value: string): boolean {
  return TEMPLATE_REGEX.test(value);
}

/**
 * Resolve {{secret-uri}} templates in a string.
 * E.g. "Bearer {{file:///.secrets/key}}" → "Bearer actual-key-value"
 */
async function resolveTemplateString(
  value: string,
  resolver: SecretResolver,
  auth?: { token?: string },
): Promise<string> {
  // Reset regex state
  TEMPLATE_REGEX.lastIndex = 0;
  const matches = [...value.matchAll(/\{\{(.+?)\}\}/g)];
  if (matches.length === 0) return value;

  let result = value;
  for (const match of matches) {
    const uri = match[1]!.trim();
    const resolved = await resolver(uri, auth);
    result = result.replace(match[0], resolved);
  }
  return result;
}

/**
 * Recursively resolve {{secret-uri}} templates in an object.
 * Walks all string values at any depth.
 */
async function resolveTemplates<T>(
  obj: T,
  resolver: SecretResolver,
  auth?: { token?: string },
): Promise<T> {
  if (typeof obj === 'string') {
    // Handle {{secret-uri}} templates
    if (hasTemplates(obj)) {
      return (await resolveTemplateString(obj, resolver, auth)) as T;
    }
    // Handle raw secret URIs (backward compat)
    if (isSecretUri(obj)) {
      return (await resolver(obj, auth)) as T;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return (await Promise.all(
      obj.map((item) => resolveTemplates(item, resolver, auth)),
    )) as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = await resolveTemplates(value, resolver, auth);
    }
    return result as T;
  }
  return obj;
}

// ============================================
// Registry Auth Headers
// ============================================

/**
 * Build auth headers for a registry based on its auth config and custom headers.
 * Merges typed auth (bearer, api-key) with arbitrary custom headers.
 */
function buildRegistryAuthHeaders(
  registry: ResolvedRegistry,
  fallbackToken?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};

  // Apply typed auth
  switch (registry.auth.type) {
    case "bearer": {
      const token = ("token" in registry.auth ? registry.auth.token : undefined) ?? fallbackToken;
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      break;
    }
    case "api-key": {
      if ("key" in registry.auth && registry.auth.key) {
        const headerName = ("header" in registry.auth ? registry.auth.header : undefined) ?? "x-api-key";
        headers[headerName] = registry.auth.key;
      }
      break;
    }
    case "jwt": {
      // JWT auth would require token exchange — not yet implemented
      if (fallbackToken) {
        headers.Authorization = `Bearer ${fallbackToken}`;
      }
      break;
    }
    case "none":
    default: {
      if (fallbackToken) {
        headers.Authorization = `Bearer ${fallbackToken}`;
      }
      break;
    }
  }

  // Merge custom headers (these override auth-generated headers)
  if (registry.headers) {
    Object.assign(headers, registry.headers);
  }

  return headers;
}

// ============================================
// Registry Discovery Types
// ============================================

/** Registry well-known configuration (from /.well-known/configuration) */
export interface RegistryConfiguration {
  issuer: string;
  jwks_uri?: string;
  token_endpoint?: string;
  agents_endpoint?: string;
  call_endpoint?: string;
  supported_grant_types?: string[];
  /** @deprecated Use agents_endpoint + GET /list instead */
  agents?: string[];
}

/** An agent definition as listed by a registry */
export interface AgentListing {
  /** Agent path (e.g., '@notion') */
  path: string;
  /** Description */
  description?: string;
  /** Publisher (registry name) */
  publisher: string;
  /** Tools available */
  tools?: Array<{
    name: string;
    description?: string;
  }>;
  /** Whether it requires auth */
  requiresAuth?: boolean;
  /** Security scheme summary (machine-readable auth type) */
  security?: SecuritySchemeSummary;
  /** Available resources (e.g., AUTH.md) */
  resources?: Array<{
    uri: string;
    name?: string;
    mimeType?: string;
  }>;
  /** Integration config if applicable */
  integration?: {
    provider: string;
    displayName: string;
    category?: string;
  };
}

/** Raw agent entry returned by the list_agents MCP tool (before normalization). */
type ListAgentsEntry = Omit<AgentListing, "publisher" | "tools"> & {
  tools?: Array<{ name: string; description?: string } | string>;
};

/** Response shape from list_agents — an array of agent entries. */
type ListAgentsResponse = ListAgentsEntry[];

// ============================================
// Secret Resolver
// ============================================

/** Resolves secret URLs to their values */
import { readFile } from "node:fs/promises";

export type SecretResolver = (
  uri: string,
  auth?: { token?: string },
) => Promise<string>;

/**
 * Default secret resolver — dispatches on URI scheme:
 *   file://  → read from filesystem
 *   env://   → read from environment variable
 *   https:// → HTTP GET with optional bearer token
 *   http://  → HTTP GET (dev only)
 */
async function defaultSecretResolver(
  uri: string,
  auth?: { token?: string },
): Promise<string> {
  const parsed = new URL(uri);

  switch (parsed.protocol) {
    case "file:": {
      const filePath = parsed.pathname;
      return (await readFile(filePath, "utf-8")).trim();
    }
    case "env:": {
      // env://VAR_NAME or env:///VAR_NAME
      const varName = parsed.hostname || parsed.pathname.replace(/^\//, "");
      const value = process.env[varName];
      if (!value) {
        throw new Error(`Environment variable not set: ${varName}`);
      }
      return value;
    }
    case "https:":
    case "http:": {
      const headers: Record<string, string> = {};
      if (auth?.token) {
        headers.Authorization = `Bearer ${auth.token}`;
      }
      const res = await fetch(uri, { headers });
      if (!res.ok) {
        throw new Error(
          `Failed to resolve secret ${uri}: ${res.status} ${res.statusText}`,
        );
      }
      return res.text();
    }
    default:
      throw new Error(`Unsupported secret URI scheme: ${parsed.protocol}`);
  }
}

// ============================================
// Direct MCP Resolution
// ============================================

/**
 * List tools from a direct MCP server (registry type: 'mcp').
 * Connects via JSON-RPC, does MCP initialize handshake, then tools/list.
 */
async function listFromMcpServer(
  url: string,
  auth: { token?: string; headers?: Record<string, string> },
  fetchFn: typeof globalThis.fetch,
): Promise<AgentListing[]> {
  const serverUrl = url.replace(/\/$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(auth.headers ?? {}),
  };
  if (auth.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }

  let reqId = 0;
  async function rpc(method: string, params?: Record<string, unknown>) {
    const res = await fetchFn(serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++reqId,
        method,
        ...(params && { params }),
      }),
    });
    if (!res.ok) {
      throw new Error(`MCP call to ${serverUrl} failed: ${res.status}`);
    }
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) {
      throw new Error(`MCP RPC error: ${json.error.message}`);
    }
    return json.result;
  }

  // Initialize handshake
  const initResult = (await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "agents-sdk-consumer", version: "1.0.0" },
  })) as { serverInfo?: { name?: string }; capabilities?: { registry?: unknown } };

  // Send initialized notification
  await rpc("notifications/initialized").catch(() => {});

  // List tools
  const toolsResult = (await rpc("tools/list")) as {
    tools?: Array<{ name: string; description?: string }>;
  };

  const serverName = initResult?.serverInfo?.name ?? new URL(serverUrl).hostname;

  // Return as a single agent listing with all tools
  return [{
    path: serverName,
    description: `MCP server at ${serverUrl}`,
    publisher: serverName,
    tools: toolsResult?.tools ?? [],
    requiresAuth: false,
  }];
}

/**
 * Call a tool on a direct MCP server.
 */
async function callMcpTool(
  url: string,
  toolName: string,
  params: Record<string, unknown>,
  auth: { token?: string; headers?: Record<string, string> },
  fetchFn: typeof globalThis.fetch,
): Promise<unknown> {
  const serverUrl = url.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(auth.headers ?? {}),
  };
  if (auth.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }

  const res = await fetchFn(serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: params },
    }),
  });
  if (!res.ok) {
    throw new Error(`MCP tool call failed: ${res.status}`);
  }
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) {
    throw new Error(`MCP RPC error: ${json.error.message}`);
  }

  // Extract text content
  const result = json.result as { content?: Array<{ type: string; text?: string }> };
  if (result?.content) {
    const textItem = result.content.find((c) => c.type === "text");
    if (textItem?.text) {
      try { return JSON.parse(textItem.text); } catch { return textItem.text; }
    }
  }
  return result;
}

// ============================================
// Direct HTTPS Resolution
// ============================================

/**
 * List available operations from an HTTPS API (registry type: 'https').
 * Returns a single generic 'call' tool since we can't auto-discover REST endpoints
 * without an OpenAPI spec.
 */
function listFromHttpsApi(url: string): AgentListing[] {
  const hostname = new URL(url).hostname;
  return [{
    path: hostname,
    description: `REST API at ${url}`,
    publisher: hostname,
    tools: [{
      name: "call",
      description: "Make an HTTP request to the API. Params: method, path, body, headers.",
    }],
    requiresAuth: false,
  }];
}

/**
 * Call an HTTPS API (registry type: 'https').
 * Generic HTTP proxy with auth injection.
 */
async function callHttpsTool(
  baseUrl: string,
  _toolName: string,
  params: Record<string, unknown>,
  auth: { token?: string; headers?: Record<string, string> },
  fetchFn: typeof globalThis.fetch,
): Promise<unknown> {
  const method = (params.method as string) ?? "GET";
  const path = (params.path as string) ?? "";
  const body = params.body as Record<string, unknown> | undefined;
  const extraHeaders = (params.headers as Record<string, string>) ?? {};

  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    ...extraHeaders,
    ...(auth.headers ?? {}),
  };
  if (auth.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetchFn(url, {
    method,
    headers,
    ...(body && { body: JSON.stringify(body) }),
  });

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    return res.json();
  }
  return res.text();
}

// ============================================
// Consumer Options
// ============================================

export interface RegistryConsumerOptions {
  /** Override the secret resolver (default: HTTP GET + JWT) */
  resolveSecret?: SecretResolver;

  /** Bearer token for authenticated registries */
  token?: string;

  /** Custom fetch implementation */
  fetch?: typeof globalThis.fetch;
}

// ============================================
// Registry Consumer
// ============================================

export interface RegistryConsumer {
  /** List all available agents across all connected registries */
  list(): Promise<AgentListing[]>;

  /** List configured refs (from the consumer's config) */
  refs(): ResolvedRef[];

  /** Get the resolved registries */
  registries(): ResolvedRegistry[];

  /** Call a tool on a configured ref */
  call(
    refName: string,
    tool: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;

  /** Discover a registry's configuration */
  discover(registryUrl: string): Promise<RegistryConfiguration>;

  /** Browse agents from a specific registry (or all if url omitted), with optional BM25 search */
  browse(registryUrl?: string, query?: string): Promise<AgentListing[]>;

  /** Inspect a specific agent — returns tools, auth requirements, resources */
  inspect(
    agentPath: string,
    registryUrl?: string,
  ): Promise<AgentListing | null>;

  /** Resolve a secret URL to its value */
  resolveSecret(url: string): Promise<string>;

  /** Resolve {{secret-uri}} templates in a config object (recursive) */
  resolveConfig(
    config: RefConfig,
  ): Promise<RefConfig>;

  /** Produce the indexed/serialized config output */
  index(): ResolvedConfig;

  /** Diff: what's available vs what's configured */
  available(): Promise<AgentListing[]>;
}

/**
 * Create a registry consumer from a config.
 *
 * The consumer connects to registries, discovers available agents,
 * and provides a unified interface for calling tools.
 */
export async function createRegistryConsumer(
  config: ConsumerConfig,
  options: RegistryConsumerOptions = {},
): Promise<RegistryConsumer> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const resolveSecretFn = options.resolveSecret ?? defaultSecretResolver;

  // Normalize registries
  const resolvedRegistries = (config.registries ?? []).map(normalizeRegistry);

  // Normalize refs
  const resolvedRefs: ResolvedRef[] = (config.refs ?? []).map((entry) => {
    return normalizeRef(entry);
  });

  // Cache for registry configurations
  const discoveryCache = new Map<string, RegistryConfiguration>();

  // Discover a registry
  async function discover(registryUrl: string, registry?: ResolvedRegistry): Promise<RegistryConfiguration> {
    const cached = discoveryCache.get(registryUrl);
    if (cached) return cached;

    const url = `${registryUrl.replace(/\/$/, "")}/.well-known/configuration`;
    const headers: Record<string, string> = registry
      ? buildRegistryAuthHeaders(registry, options.token)
      : (options.token ? { Authorization: `Bearer ${options.token}` } : {});
    const res = await fetchFn(url, { headers });
    if (!res.ok) {
      throw new Error(
        `Failed to discover registry ${registryUrl}: ${res.status}`,
      );
    }
    const configuration = (await res.json()) as RegistryConfiguration;
    discoveryCache.set(registryUrl, configuration);
    return configuration;
  }

  // List agents from a single registry via MCP tools/call list_agents
  async function listFromRegistry(
    registry: ResolvedRegistry,
    query?: string,
  ): Promise<AgentListing[]> {
    const configuration = await discover(registry.url, registry);
    const mcpUrl =
      configuration.call_endpoint ?? registry.url.replace(/\/$/, "");

    const agents = await callMcpTool(
      mcpUrl,
      "list_agents",
      query ? { query } : {},
      {
        token: options.token,
        headers: buildRegistryAuthHeaders(registry, options.token),
      },
      fetchFn,
    ) as ListAgentsResponse;

    return agents.map((agent) => ({
      ...agent,
      ...agent,
      // Normalize tools: strings become { name } objects
      tools: agent.tools?.map((t) =>
        typeof t === "string" ? { name: t } : t,
      ),
      publisher: registry.publisher,
    }));
  }

  // Send any call_agent request through a registry's MCP endpoint
  async function callRegistry(
    registry: ResolvedRegistry,
    request: CallAgentRequest,
  ): Promise<unknown> {
    const configuration = await discover(registry.url, registry);
    const mcpUrl =
      configuration.call_endpoint ?? registry.url.replace(/\/$/, "");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...buildRegistryAuthHeaders(registry, options.token),
    };

    const requestId = `call-${Date.now()}`;
    const res = await fetchFn(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: {
          name: "call_agent",
          arguments: { request },
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error");
      throw new Error(
        `Registry call failed (${registry.url}): ${res.status} ${text}`,
      );
    }

    const rpcResponse = (await res.json()) as {
      jsonrpc: string;
      id: string;
      result?: {
        content?: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      error?: { code: number; message: string };
    };

    if (rpcResponse.error) {
      throw new Error(
        `Registry RPC error: ${rpcResponse.error.message}`,
      );
    }

    const mcpResult = rpcResponse.result;
    if (mcpResult?.isError) {
      const errorText =
        mcpResult.content?.map((c) => c.text).join("\n") ?? "Unknown error";
      throw new Error(`Registry call error: ${errorText}`);
    }

    // Parse text content
    const textContent = mcpResult?.content?.find((c) => c.type === "text");
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return textContent.text;
      }
    }

    return mcpResult;
  }

  // Call a tool via a registry (convenience wrapper)
  async function callTool(
    registry: ResolvedRegistry,
    agentPath: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return callRegistry(registry, {
      action: "execute_tool",
      path: agentPath,
      tool,
      params,
    });
  }

  // Build the consumer
  const consumer: RegistryConsumer = {
    async list(): Promise<AgentListing[]> {
      // Collect from standard registries
      const registryResults = await Promise.allSettled(
        resolvedRegistries.map((r) => listFromRegistry(r)),
      );
      const listings = registryResults.flatMap((r) =>
        r.status === "fulfilled" ? r.value : [],
      );

      // Also collect from direct MCP/HTTPS refs
      for (const ref of resolvedRefs) {
        if (!ref.scheme || !DIRECT_REGISTRY_TYPES.has(ref.scheme)) continue;
        if (!ref.url) continue;

        try {
          if (ref.scheme === REGISTRY_TYPE_MCP) {
            const mcpListings = await listFromMcpServer(
              ref.url,
              { token: options.token },
              fetchFn,
            );
            listings.push(...mcpListings);
          } else if (ref.scheme === REGISTRY_TYPE_HTTPS) {
            listings.push(...listFromHttpsApi(ref.url));
          }
        } catch {
          // Skip unreachable direct refs during list
        }
      }

      return listings;
    },

    refs(): ResolvedRef[] {
      return resolvedRefs;
    },

    registries(): ResolvedRegistry[] {
      return resolvedRegistries;
    },

    async call(
      refName: string,
      tool: string,
      params: Record<string, unknown> = {},
    ): Promise<unknown> {
      const ref = resolvedRefs.find((r) => r.name === refName);
      if (!ref) {
        throw new Error(
          `Ref "${refName}" not found in config. Available: ${resolvedRefs.map((r) => r.name).join(", ")}`,
        );
      }

      // Resolve config headers ({{secret-uri}} templates)
      const configHeaders = ref.config?.headers as
        | Record<string, string>
        | undefined;
      const resolvedHeaders = configHeaders
        ? await resolveTemplates(configHeaders, resolveSecretFn, {
            token: options.token,
          })
        : undefined;
      const auth = { token: options.token, headers: resolvedHeaders };

      // Direct MCP ref — bypass registry, call MCP server directly
      if (ref.scheme === REGISTRY_TYPE_MCP) {
        if (!ref.url) {
          throw new Error(`MCP ref "${refName}" has no url`);
        }
        return callMcpTool(ref.url, tool, params, auth, fetchFn);
      }

      // Direct HTTPS ref — bypass registry, call REST API directly
      if (ref.scheme === REGISTRY_TYPE_HTTPS) {
        if (!ref.url) {
          throw new Error(`HTTPS ref "${refName}" has no url`);
        }
        return callHttpsTool(ref.url, tool, params, auth, fetchFn);
      }

      // Standard registry ref
      const registryUrl = ref.sourceRegistry?.url;
      const registry = registryUrl
        ? resolvedRegistries.find(
            (r) => r.url === registryUrl || r.name === registryUrl,
          )
        : resolvedRegistries[0]; // Default to first registry if no source specified
      if (!registry) {
        throw new Error(
          `Registry not found for ref "${refName}"${registryUrl ? ` (source: ${registryUrl})` : ''}`,
        );
      }

      return callTool(registry, ref.ref, tool, params);
    },

    discover(registryUrl: string) {
      // Find matching resolved registry for auth headers
      const registry = resolvedRegistries.find((r) => r.url === registryUrl);
      return discover(registryUrl, registry);
    },

    async browse(registryUrl?: string, query?: string): Promise<AgentListing[]> {
      // List agents from a specific registry, or all registries if not specified
      const targets = registryUrl
        ? resolvedRegistries.filter(
            (r) => r.url === registryUrl || r.name === registryUrl,
          )
        : resolvedRegistries;
      // Pass query to server for BM25 search
      const results = await Promise.allSettled(
        targets.map((t) => listFromRegistry(t, query)),
      );
      return results.flatMap((r) =>
        r.status === "fulfilled" ? r.value : [],
      );
    },

    async inspect(
      agentPath: string,
      registryUrl?: string,
    ): Promise<AgentListing | null> {
      const targetRegistries = registryUrl
        ? resolvedRegistries.filter((r) => r.url === registryUrl || r.name === registryUrl)
        : resolvedRegistries;

      // Parallel O(1) lookups via describe_tools
      const results = await Promise.allSettled(
        targetRegistries.map(async (registry) => {
          const data = (await callRegistry(registry, {
            action: "describe_tools",
            path: agentPath,
            tools: [],
          })) as { tools?: unknown[]; description?: string } | null;
          if (!data) return null;
          return {
            path: agentPath,
            publisher: registry.publisher,
            tools: data.tools,
            description: data.description,
          } as AgentListing;
        }),
      );

      for (const r of results) {
        if (r.status === "fulfilled" && r.value) return r.value;
      }
      return null;
    },

    async resolveSecret(url: string): Promise<string> {
      return resolveSecretFn(url, { token: options.token });
    },

    async resolveConfig(config: RefConfig): Promise<RefConfig> {
      return resolveTemplates(config, resolveSecretFn, {
        token: options.token,
      });
    },

    index(): ResolvedConfig {
      return {
        resolvedAt: new Date().toISOString(),
        sourceHash: simpleHash(JSON.stringify(config)),
        registries: resolvedRegistries,
        refs: resolvedRefs,
        meta: config.meta,
      };
    },

    async available(): Promise<AgentListing[]> {
      const all = await consumer.list();
      const configuredRefs = new Set(resolvedRefs.map((r) => r.ref));
      return all.filter((a) => !configuredRefs.has(a.path));
    },
  };

  return consumer;
}

// ============================================
// Utilities
// ============================================

/** Simple hash for cache invalidation (not cryptographic) */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}
