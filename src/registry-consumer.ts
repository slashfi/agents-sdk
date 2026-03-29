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
import { normalizeRef, normalizeRegistry, isSecretUrl } from "./define-config.js";

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
  resolveConfig(config: RefConfig): Promise<Record<string, string | number | boolean>>;

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
  async function discover(
    registryUrl: string,
  ): Promise<RegistryConfiguration> {
    const cached = discoveryCache.get(registryUrl);
    if (cached) return cached;

    const url = `${registryUrl.replace(/\/$/, "")}/.well-known/configuration`;
    const res = await fetchFn(url);
    if (!res.ok) {
      throw new Error(`Failed to discover registry ${registryUrl}: ${res.status}`);
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
      integration?: { provider: string; displayName: string; category?: string };
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
      configuration.call_endpoint ??
      `${registry.url.replace(/\/$/, "")}/call`;

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
      const results = await Promise.allSettled(
        resolvedRegistries.map(listFromRegistry),
      );
      return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
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

      const registry = resolvedRegistries.find((r) => r.url === ref.registry);
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
