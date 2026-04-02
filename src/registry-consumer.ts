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
import {
  isSecretUrl,
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
    if (hasTemplates(obj)) {
      return (await resolveTemplateString(obj, resolver, auth)) as T;
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
  /** Integration config if applicable */
  integration?: {
    provider: string;
    displayName: string;
    category?: string;
  };
}

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

  /** Resolve a secret URL to its value */
  resolveSecret(url: string): Promise<string>;

  /** Resolve all secret URLs in a config object, returning resolved values */
  resolveConfig(
    config: RefConfig,
  ): Promise<Record<string, string | number | boolean>>;

  /** Resolve {{secret-uri}} templates in a headers object */
  resolveHeaders(
    headers: Record<string, string>,
  ): Promise<Record<string, string>>;

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
    const normalized = normalizeRef(entry);
    return {
      ref: normalized.ref,
      name: normalized.name,
      registry: normalized.registry ?? resolvedRegistries[0]?.url ?? "unknown",
      config: normalized.config,
    };
  });

  // Cache for registry configurations
  const discoveryCache = new Map<string, RegistryConfiguration>();

  // Discover a registry
  async function discover(registryUrl: string): Promise<RegistryConfiguration> {
    const cached = discoveryCache.get(registryUrl);
    if (cached) return cached;

    const url = `${registryUrl.replace(/\/$/, "")}/.well-known/configuration`;
    const res = await fetchFn(url);
    if (!res.ok) {
      throw new Error(
        `Failed to discover registry ${registryUrl}: ${res.status}`,
      );
    }
    const configuration = (await res.json()) as RegistryConfiguration;
    discoveryCache.set(registryUrl, configuration);
    return configuration;
  }

  // List agents from a single registry
  async function listFromRegistry(
    registry: ResolvedRegistry,
  ): Promise<AgentListing[]> {
    const configuration = await discover(registry.url);
    const listUrl =
      configuration.agents_endpoint ??
      `${registry.url.replace(/\/$/, "")}/list`;

    const headers: Record<string, string> = {};
    if (registry.auth.type === "bearer" && "token" in registry.auth) {
      headers.Authorization = `Bearer ${registry.auth.token}`;
    } else if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    const res = await fetchFn(listUrl, { headers });
    if (!res.ok) {
      throw new Error(
        `Failed to list agents from ${registry.url}: ${res.status}`,
      );
    }

    const agents = (await res.json()) as Array<{
      path: string;
      description?: string;
      tools?: Array<{ name: string; description?: string }>;
      integration?: {
        provider: string;
        displayName: string;
        category?: string;
      };
    }>;

    return agents.map((agent) => ({
      ...agent,
      publisher: registry.publisher,
    }));
  }

  // Call a tool via a registry
  async function callTool(
    registry: ResolvedRegistry,
    agentPath: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const configuration = await discover(registry.url);
    const callUrl =
      configuration.call_endpoint ?? `${registry.url.replace(/\/$/, "")}/call`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (registry.auth.type === "bearer" && "token" in registry.auth) {
      headers.Authorization = `Bearer ${registry.auth.token}`;
    } else if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    const res = await fetchFn(callUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: agentPath, tool, params }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error");
      throw new Error(
        `Tool call failed (${registry.url}/${agentPath}/${tool}): ${res.status} ${text}`,
      );
    }

    return res.json();
  }

  // Build the consumer
  const consumer: RegistryConsumer = {
    async list(): Promise<AgentListing[]> {
      // Collect from standard registries
      const registryResults = await Promise.allSettled(
        resolvedRegistries.map(listFromRegistry),
      );
      const listings = registryResults.flatMap((r) =>
        r.status === "fulfilled" ? r.value : [],
      );

      // Also collect from direct MCP/HTTPS refs
      for (const ref of resolvedRefs) {
        if (!DIRECT_REGISTRY_TYPES.has(ref.registry)) continue;
        const refEntry = (config.refs ?? []).find((r) => {
          const n = normalizeRef(r);
          return n.name === ref.name;
        });
        const url =
          typeof refEntry === "object" ? refEntry?.url : undefined;
        if (!url) continue;

        try {
          if (ref.registry === REGISTRY_TYPE_MCP) {
            const mcpListings = await listFromMcpServer(
              url,
              { token: options.token },
              fetchFn,
            );
            listings.push(...mcpListings);
          } else if (ref.registry === REGISTRY_TYPE_HTTPS) {
            listings.push(...listFromHttpsApi(url));
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

      // Direct MCP ref — bypass registry, call MCP server directly
      if (ref.registry === REGISTRY_TYPE_MCP) {
        const refEntry = (config.refs ?? []).find((r) => {
          const n = normalizeRef(r);
          return n.name === ref.name;
        });
        const url = typeof refEntry === "object" ? refEntry?.url : undefined;
        if (!url) {
          throw new Error(`MCP ref "${refName}" has no url`);
        }
        return callMcpTool(url, tool, params, { token: options.token }, fetchFn);
      }

      // Direct HTTPS ref — bypass registry, call REST API directly
      if (ref.registry === REGISTRY_TYPE_HTTPS) {
        const refEntry = (config.refs ?? []).find((r) => {
          const n = normalizeRef(r);
          return n.name === ref.name;
        });
        const url = typeof refEntry === "object" ? refEntry?.url : undefined;
        if (!url) {
          throw new Error(`HTTPS ref "${refName}" has no url`);
        }
        return callHttpsTool(url, tool, params, { token: options.token }, fetchFn);
      }

      // Standard registry ref
      const registry = resolvedRegistries.find(
        (r) => r.url === ref.registry || r.name === ref.registry,
      );
      if (!registry) {
        throw new Error(
          `Registry "${ref.registry}" not found for ref "${refName}"`,
        );
      }

      return callTool(registry, ref.ref, tool, params);
    },

    discover,

    async resolveSecret(url: string): Promise<string> {
      return resolveSecretFn(url, { token: options.token });
    },

    async resolveConfig(
      config: RefConfig,
    ): Promise<Record<string, string | number | boolean>> {
      const resolved: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(config)) {
        if (isSecretUrl(value)) {
          resolved[key] = await resolveSecretFn(value as string, {
            token: options.token,
          });
        } else {
          resolved[key] = value;
        }
      }
      return resolved;
    },

    async resolveHeaders(
      headers: Record<string, string>,
    ): Promise<Record<string, string>> {
      return resolveTemplates(headers, resolveSecretFn, {
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
