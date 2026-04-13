/**
 * ADK Config Store — programmatic API for managing registries and refs.
 *
 * Provides a `createAdk(fs, options?)` factory that returns an object
 * with `registry.*` and `ref.*` namespaces. Backed by a pluggable
 * FsStore so it works with local filesystem (CLI) or VCS (atlas).
 *
 * @example
 * ```typescript
 * import { createAdk, createLocalFsStore } from '@slashfi/agents-sdk';
 *
 * const adk = createAdk(createLocalFsStore());
 * await adk.registry.add({ url: 'https://registry.slash.com', name: 'slash' });
 * await adk.registry.browse('public');
 * await adk.ref.add({ ref: 'notion', registry: 'public' });
 * await adk.ref.call('notion', 'notion-search', { query: 'hello' });
 * ```
 */

import type { FsStore } from "./agent-definitions/config.js";
import type {
  ConsumerConfig,
  ProxyEntry,
  RefEntry,
  RegistryEntry,
  ResolvedRef,
  ResolvedRegistry,
} from "./define-config.js";
import { normalizeRef } from "./define-config.js";
import { createRegistryConsumer } from "./registry-consumer.js";
import type {
  AgentListing,
  RegistryConfiguration,
  RegistryConsumer,
} from "./registry-consumer.js";
import type { CallAgentResponse, SecuritySchemeSummary } from "./types.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { AdkError } from "./adk-error.js";
import {
  discoverOAuthMetadata,
  dynamicClientRegistration,
  buildOAuthAuthorizeUrl,
  exchangeCodeForTokens,
} from "./mcp-client.js";

const CONFIG_PATH = "consumer-config.json";
const SECRET_PREFIX = "secret:";

// ============================================
// Types
// ============================================

/** Context passed to the resolveCredentials callback */
export interface ResolveCredentialsContext {
  /** Ref name */
  ref: string;
  /** Credential field being resolved (e.g. "client_id", "client_secret", "api_key") */
  field: string;
  /** The full ref entry from config */
  entry: RefEntry;
  /** Security scheme from the registry */
  security: SecuritySchemeSummary | null;
  /** OAuth metadata if available (from discovery) */
  oauthMetadata?: import("./mcp-client.js").OAuthServerMetadata | null;
}

/**
 * Resolve a credential field for a ref.
 * Called during auth() when the adk needs a credential it can't auto-obtain.
 * Return the value, or null to indicate it's not available.
 */
export type ResolveCredentials = (
  ctx: ResolveCredentialsContext,
) => Promise<string | null>;

export interface AdkOptions {
  /** Passphrase for encrypting/decrypting secret: values */
  encryptionKey?: string;
  /** Bearer token for authenticated registries */
  token?: string;
  /**
   * OAuth callback URL. Defaults to http://localhost:8919/callback.
   * Set this to your server's callback endpoint in non-local environments
   * (e.g. atlas), then call adk.handleCallback() when it arrives.
   */
  oauthCallbackUrl?: string;
  /** Port for local OAuth callback server (default 8919) */
  oauthCallbackPort?: number;
  /** Client name for OAuth dynamic client registration (default: "adk") */
  oauthClientName?: string;
  /**
   * Resolve preconfigured credentials for a ref.
   * Used by atlas to inject platform-level or tenant-level credentials
   * (e.g. client_id/client_secret) before the user auth flow runs.
   */
  resolveCredentials?: ResolveCredentials;
}

export interface RegistryTestResult {
  name: string;
  url: string;
  status: "active" | "error";
  issuer?: string;
  error?: string;
}

export interface AdkRegistryApi {
  add(entry: RegistryEntry): Promise<void>;
  remove(nameOrUrl: string): Promise<boolean>;
  list(): Promise<RegistryEntry[]>;
  get(name: string): Promise<RegistryEntry | null>;
  update(name: string, updates: Partial<RegistryEntry>): Promise<boolean>;
  browse(name: string, query?: string): Promise<AgentListing[]>;
  inspect(name: string): Promise<RegistryConfiguration>;
  test(name?: string): Promise<RegistryTestResult[]>;
}

/** Describes a single credential field requirement */
export interface CredentialField {
  required: boolean;
  /** Can be obtained automatically (dynamic registration, OAuth flow) */
  automated: boolean;
  /** Already present in the ref's config */
  present: boolean;
  /** Available via resolveCredentials callback */
  resolvable: boolean;
}

/** Describes what auth a ref needs and what's already provided */
export interface RefAuthStatus {
  name: string;
  security: SecuritySchemeSummary | null;
  /** All required fields are either present, resolvable, or automated */
  complete: boolean;
  /** Per-field breakdown */
  fields: Record<string, CredentialField>;
}

export interface OAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  clientId: string;
}

export interface AuthStartResult {
  type: string;
  complete: boolean;
  /** For OAuth: the URL to open in the browser */
  authorizeUrl?: string;
}

export interface AdkRefApi {
  add(entry: RefEntry): Promise<{ security: SecuritySchemeSummary | null }>;
  remove(name: string): Promise<boolean>;
  list(): Promise<ResolvedRef[]>;
  get(name: string): Promise<RefEntry | null>;
  update(name: string, updates: Partial<RefEntry>): Promise<boolean>;
  inspect(name: string, options?: { full?: boolean }): Promise<AgentListing | null>;
  call(name: string, tool: string, params?: Record<string, unknown>): Promise<CallAgentResponse>;
  resources(name: string): Promise<CallAgentResponse>;
  read(name: string, uris: string[]): Promise<CallAgentResponse>;
  /** Check auth status — what's needed vs what's stored */
  authStatus(name: string): Promise<RefAuthStatus>;
  /**
   * Start the auth flow for a ref. Returns the authorize URL for OAuth.
   * Call adk.handleCallback() when the callback arrives, or use
   * adk.ref.authLocal() to spin up a local server and block.
   */
  auth(name: string, opts?: {
    /** For API key / bearer auth: the key/token value */
    apiKey?: string;
    /** Extra context to encode in the OAuth state (e.g., tenant/user IDs for multi-tenant callbacks) */
    stateContext?: Record<string, unknown>;
    /** Additional scopes to request (e.g., optional scopes declared by the agent) */
    scopes?: string[];
  }): Promise<AuthStartResult>;
  /**
   * Run the full OAuth flow locally: start auth, spin up a callback
   * server, open the browser, wait for the redirect, exchange tokens.
   * Resolves when auth is complete or times out.
   */
  authLocal(name: string, opts?: {
    /** Called with the authorize URL (e.g. to open in browser) */
    onAuthorizeUrl?: (url: string) => void;
    /** Timeout in ms (default 300_000 = 5 min) */
    timeoutMs?: number;
  }): Promise<{ complete: boolean }>;
}

export interface AdkProxyApi {
  add(entry: ProxyEntry): Promise<void>;
  remove(name: string): Promise<boolean>;
  list(): Promise<ProxyEntry[]>;
}

export interface Adk {
  proxy: AdkProxyApi;
  registry: AdkRegistryApi;
  ref: AdkRefApi;
  readConfig(): Promise<ConsumerConfig>;
  writeConfig(config: ConsumerConfig): Promise<void>;
  /**
   * Handle an OAuth callback. Works in any environment.
   * Parse the callback query params and pass them here.
   * @returns the ref name and whether auth is complete
   */
  handleCallback(params: { code: string; state: string }): Promise<{ refName: string; complete: boolean; stateContext?: Record<string, unknown> }>;
}

// ============================================
// Internal helpers
// ============================================

function refName(entry: RefEntry): string {
  return normalizeRef(entry).name;
}

/**
 * Find a ref by name, trying both with and without `@` prefix.
 * Refs may be stored as `@foo` or `foo` depending on how they were added;
 * this ensures lookups work regardless of which form the caller uses.
 */
function findRef(refs: RefEntry[], name: string): RefEntry | undefined {
  const match = refs.find((r) => refName(r) === name);
  if (match) return match;
  const alt = name.startsWith("@") ? name.slice(1) : `@${name}`;
  return refs.find((r) => refName(r) === alt);
}

/**
 * Match a ref name with @ normalization (for filter/map operations).
 */
function refNameMatches(entry: RefEntry, name: string): boolean {
  const n = refName(entry);
  if (n === name) return true;
  const alt = name.startsWith("@") ? name.slice(1) : `@${name}`;
  return n === alt;
}

function registryDisplayName(r: string | RegistryEntry): string {
  return typeof r === "string" ? r : (r.name ?? r.url);
}

function registryUrl(r: string | RegistryEntry): string {
  return typeof r === "string" ? r : r.url;
}

function findRegistry(
  registries: Array<string | RegistryEntry>,
  nameOrUrl: string,
): (string | RegistryEntry) | undefined {
  return registries.find((r) => {
    if (typeof r === "string") return r === nameOrUrl;
    return (r.name ?? r.url) === nameOrUrl || r.url === nameOrUrl;
  });
}

/**
 * Walk an object and decrypt any string values starting with "secret:".
 */
async function decryptConfigSecrets(
  obj: Record<string, unknown>,
  encryptionKey: string,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.startsWith(SECRET_PREFIX)) {
      result[key] = await decryptSecret(value.slice(SECRET_PREFIX.length), encryptionKey);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = await decryptConfigSecrets(value as Record<string, unknown>, encryptionKey);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ============================================
// Factory
// ============================================

export function createAdk(fs: FsStore, options: AdkOptions = {}): Adk {

  async function readConfig(): Promise<ConsumerConfig> {
    const content = await fs.readFile(CONFIG_PATH);
    if (!content) return {};
    try {
      return JSON.parse(content) as ConsumerConfig;
    } catch {
      return {};
    }
  }

  async function writeConfig(config: ConsumerConfig): Promise<void> {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  /**
   * Store a secret value in a ref's config, encrypted if encryptionKey is set.
   * The value is stored inline as "secret:<encrypted>" in consumer-config.json.
   */
  async function storeRefSecret(name: string, key: string, value: string): Promise<void> {
    const stored = options.encryptionKey
      ? `${SECRET_PREFIX}${await encryptSecret(value, options.encryptionKey)}`
      : value;
    const config = await readConfig();
    const refs = (config.refs ?? []).map((r): RefEntry => {
      if (refName(r) !== name) return r;
      return { ...r, config: { ...r.config, [key]: stored } };
    });
    await writeConfig({ ...config, refs });
  }

  async function readRefSecret(name: string, key: string): Promise<string | null> {
    const config = await readConfig();
    const entry = findRef(config.refs ?? [], name);
    const value = entry?.config?.[key];
    if (typeof value !== "string") return null;
    if (value.startsWith(SECRET_PREFIX) && options.encryptionKey) {
      return decryptSecret(value.slice(SECRET_PREFIX.length), options.encryptionKey);
    }
    return value;
  }



  const PENDING_OAUTH_PATH = "pending-oauth.json";

  interface PendingOAuthState {
    refName: string;
    codeVerifier: string;
    clientId: string;
    clientSecret?: string;
    tokenEndpoint: string;
    redirectUri: string;
    createdAt: number;
  }

  async function readPendingOAuth(): Promise<Record<string, PendingOAuthState>> {
    const content = await fs.readFile(PENDING_OAUTH_PATH);
    if (!content) return {};
    try { return JSON.parse(content); } catch { return {}; }
  }

  async function writePendingOAuth(pending: Record<string, PendingOAuthState>): Promise<void> {
    await fs.writeFile(PENDING_OAUTH_PATH, JSON.stringify(pending, null, 2));
  }

  async function storePendingOAuth(state: string, data: PendingOAuthState): Promise<void> {
    const pending = await readPendingOAuth();
    pending[state] = data;
    await writePendingOAuth(pending);
  }

  async function consumePendingOAuth(state: string): Promise<PendingOAuthState | null> {
    const pending = await readPendingOAuth();
    const data = pending[state] ?? null;
    if (data) {
      delete pending[state];
      await writePendingOAuth(pending);
    }
    return data;
  }

  /** Call an MCP server directly with a bearer token (bypasses registry). */
  async function callMcpDirect(
    serverUrl: string,
    toolName: string,
    params: Record<string, unknown>,
    token: string,
  ): Promise<CallAgentResponse> {
    const url = serverUrl.replace(/\/$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    };

    let reqId = 0;
    let sessionId: string | undefined;
    async function rpc(method: string, rpcParams?: Record<string, unknown>) {
      const reqHeaders = { ...headers, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) };
      const res = await globalThis.fetch(url, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++reqId,
          method,
          ...(rpcParams && { params: rpcParams }),
        }),
      });
      if (!res.ok) {
        throw new Error(`MCP ${method} failed (${res.status}): ${await res.text().catch(() => "unknown")}`);
      }

      const contentType = res.headers.get("content-type") ?? "";

      // Capture session ID from response
      const newSessionId = res.headers.get("mcp-session-id");
      if (newSessionId) sessionId = newSessionId;

      // SSE response — parse events to find the JSON-RPC result
      if (contentType.includes("text/event-stream")) {
        const text = await res.text();
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const json = JSON.parse(line.slice(6));
              if (json.id === reqId) {
                if (json.error) throw new Error(`MCP RPC error: ${json.error.message}`);
                return json.result;
              }
            } catch (e) {
              if (e instanceof Error && e.message.startsWith("MCP RPC")) throw e;
            }
          }
        }
        return undefined;
      }

      const json = await res.json() as { result?: unknown; error?: { message: string } };
      if (json.error) throw new Error(`MCP RPC error: ${json.error.message}`);
      return json.result;
    }

    try {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "adk", version: "1.0.0" },
      });
      await rpc("notifications/initialized").catch(() => {});

      const result = await rpc("tools/call", { name: toolName, arguments: params }) as
        { content?: Array<{ type: string; text?: string }>; isError?: boolean };

      const textContent = result?.content?.find((c) => c.type === "text");
      if (textContent?.text) {
        try { return { success: true, result: JSON.parse(textContent.text) } as CallAgentResponse; }
        catch { return { success: true, result: textContent.text } as CallAgentResponse; }
      }
      return { success: true, result } as CallAgentResponse;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) } as CallAgentResponse;
    }
  }

  function callbackUrl(): string {
    const port = options.oauthCallbackPort ?? 8919;
    return options.oauthCallbackUrl ?? `http://localhost:${port}/callback`;
  }

  /** Try fetching a URL directly as OAuth metadata (it may already be a discovery URL). */
  async function tryFetchOAuthMetadata(url: string): Promise<import("./mcp-client.js").OAuthServerMetadata | null> {
    try {
      const res = await globalThis.fetch(url);
      if (!res.ok) return null;
      const data = await res.json() as Record<string, unknown>;
      if (data.authorization_endpoint && data.token_endpoint) {
        return data as unknown as import("./mcp-client.js").OAuthServerMetadata;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Build a registryConsumer from the current config.
   * Decrypts secret: values in registry headers/auth before connecting.
   */
  async function buildConsumer(
    registryFilter?: string,
  ): Promise<RegistryConsumer> {
    const config = await readConfig();
    let registries = config.registries ?? [];

    if (registryFilter) {
      const target = findRegistry(registries, registryFilter);
      if (!target) {
        throw new Error(
          `Registry "${registryFilter}" not found. Available: ${registries.map(registryDisplayName).join(", ")}`,
        );
      }
      registries = [target];
    }

    // Decrypt secret: values in registry entries if encryption key is set
    const resolved = options.encryptionKey
      ? await Promise.all(
          registries.map(async (r) => {
            if (typeof r === "string") return r;
            const decrypted = await decryptConfigSecrets(
              r as unknown as Record<string, unknown>,
              options.encryptionKey!,
            );
            return decrypted as unknown as RegistryEntry;
          }),
        )
      : registries;

    return createRegistryConsumer(
      { registries: resolved, refs: config.refs ?? [] },
      { token: options.token },
    );
  }

  /**
   * Build a consumer that includes the ref's sourceRegistry if present.
   * This ensures calls/inspect route to the correct registry endpoint.
   */
  async function buildConsumerForRef(entry: RefEntry): Promise<RegistryConsumer> {
    const config = await readConfig();
    let registries = config.registries ?? [];

    // If the ref has a sourceRegistry, ensure it's included in the consumer's registries
    if (entry.sourceRegistry?.url) {
      const sourceUrl = entry.sourceRegistry.url;
      const alreadyIncluded = registries.some((r) =>
        typeof r === "string" ? r === sourceUrl : r.url === sourceUrl,
      );
      if (!alreadyIncluded) {
        registries = [...registries, { url: sourceUrl, name: sourceUrl }];
      }
    }

    const resolved = options.encryptionKey
      ? await Promise.all(
          registries.map(async (r) => {
            if (typeof r === "string") return r;
            const decrypted = await decryptConfigSecrets(
              r as unknown as Record<string, unknown>,
              options.encryptionKey!,
            );
            return decrypted as unknown as RegistryEntry;
          }),
        )
      : registries;

    return createRegistryConsumer(
      { registries: resolved, refs: config.refs ?? [] },
      { token: options.token },
    );
  }

  /**
   * Resolve the correct registry for a ref.
   * If the ref has a sourceRegistry, use that; otherwise fall back to the first registry.
   */
  function resolveRegistryForRef(consumer: RegistryConsumer, entry: RefEntry): ResolvedRegistry {
    const regs = consumer.registries();
    if (entry.sourceRegistry?.url) {
      const match = regs.find((r) => r.url === entry.sourceRegistry!.url);
      if (match) return match;
    }
    const fallback = regs[0];
    if (!fallback) throw new Error("No registry available");
    return fallback;
  }

  // ==========================================
  // Registry API
  // ==========================================

  const registry: AdkRegistryApi = {
    async add(entry: RegistryEntry): Promise<void> {
      const config = await readConfig();
      const alias = entry.name ?? entry.url;
      const registries = (config.registries ?? []).filter(
        (r) => registryDisplayName(r) !== alias,
      );
      registries.push(entry);
      await writeConfig({ ...config, registries });
    },

    async remove(nameOrUrl: string): Promise<boolean> {
      const config = await readConfig();
      if (!config.registries?.length) return false;
      const before = config.registries.length;
      const registries = config.registries.filter(
        (r) => registryDisplayName(r) !== nameOrUrl && registryUrl(r) !== nameOrUrl,
      );
      if (registries.length === before) return false;
      await writeConfig({ ...config, registries });
      return true;
    },

    async list(): Promise<RegistryEntry[]> {
      const config = await readConfig();
      return (config.registries ?? []).map((r) =>
        typeof r === "string" ? { url: r } : r,
      );
    },

    async get(name: string): Promise<RegistryEntry | null> {
      const config = await readConfig();
      const target = findRegistry(config.registries ?? [], name);
      if (!target) return null;
      return typeof target === "string" ? { url: target } : target;
    },

    async update(name: string, updates: Partial<RegistryEntry>): Promise<boolean> {
      const config = await readConfig();
      if (!config.registries?.length) return false;
      let found = false;
      const registries = config.registries.map((r): string | RegistryEntry => {
        const rName = registryDisplayName(r);
        if (rName !== name && registryUrl(r) !== name) return r;
        found = true;
        const existing: RegistryEntry = typeof r === "string" ? { url: r } : { ...r };
        if (updates.url) existing.url = updates.url;
        if (updates.name) existing.name = updates.name;
        if (updates.auth) existing.auth = updates.auth;
        if (updates.headers) existing.headers = { ...existing.headers, ...updates.headers };
        return existing;
      });
      if (!found) return false;
      await writeConfig({ ...config, registries });
      return true;
    },

    async browse(name: string, query?: string): Promise<AgentListing[]> {
      const consumer = await buildConsumer(name);
      const config = await readConfig();
      const target = findRegistry(config.registries ?? [], name);
      const url = target ? registryUrl(target) : name;
      return consumer.browse(url, query);
    },

    async inspect(name: string): Promise<RegistryConfiguration> {
      const consumer = await buildConsumer(name);
      const config = await readConfig();
      const target = findRegistry(config.registries ?? [], name);
      const url = target ? registryUrl(target) : name;
      return consumer.discover(url);
    },

    async test(name?: string): Promise<RegistryTestResult[]> {
      const config = await readConfig();
      const registries = config.registries ?? [];
      const targets = name
        ? registries.filter((r) => registryDisplayName(r) === name || registryUrl(r) === name)
        : registries;

      const results = await Promise.allSettled(
        targets.map(async (r): Promise<RegistryTestResult> => {
          const url = registryUrl(r);
          const rName = registryDisplayName(r);
          try {
            const consumer = await createRegistryConsumer({ registries: [r] }, { token: options.token });
            const disc = await consumer.discover(url);
            return { name: rName, url, status: "active", issuer: disc.issuer };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "unknown";
            return { name: rName, url, status: "error", error: msg };
          }
        }),
      );

      return results.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : { name: "unknown", url: "unknown", status: "error" as const, error: "unknown" },
      );
    },
  };

  // ==========================================
  // Ref API
  // ==========================================

  const ref: AdkRefApi = {
    async add(entry: RefEntry): Promise<{ security: SecuritySchemeSummary | null }> {
      let security: SecuritySchemeSummary | null = null;

      const config = await readConfig();
      const hasRegistries = (config.registries ?? []).length > 0;

      // Auto-infer scheme from context
      if (!entry.scheme) {
        if (entry.sourceRegistry?.url) {
          entry = { ...entry, scheme: "registry" };
        } else if (entry.url) {
          entry = { ...entry, scheme: entry.url.startsWith("http") ? "https" : "mcp" };
        } else {
          throw new AdkError({
            code: "REF_INVALID",
            message: `Cannot add ref "${entry.ref}": could not determine connection type`,
            hint: "Use --registry <name> to install from a registry, or --url <url> for a direct connection",
            details: { ref: entry.ref },
          });
        }
      }

      // Validate scheme-specific requirements
      if (entry.scheme === "registry" && !entry.sourceRegistry?.url) {
        throw new AdkError({
          code: "REF_INVALID",
          message: `Cannot add ref "${entry.ref}": registry scheme requires a source registry`,
          hint: "Use --registry <name> (e.g. adk ref add notion --registry public)",
          details: { ref: entry.ref, scheme: entry.scheme },
        });
      }

      if ((entry.scheme === "mcp" || entry.scheme === "https") && !entry.url) {
        throw new AdkError({
          code: "REF_INVALID",
          message: `Cannot add ref "${entry.ref}": scheme '${entry.scheme}' requires url`,
          hint: "Provide the direct agent URL with: url: 'https://...'",
          details: { ref: entry.ref, scheme: entry.scheme },
        });
      }

      if (hasRegistries || entry.sourceRegistry?.url) {
        try {
          const consumer = await buildConsumerForRef(entry);
          const agentToInspect = entry.sourceRegistry?.agentPath ?? entry.ref;
          const info = await consumer.inspect(agentToInspect);

          const requiresValidation = !!entry.sourceRegistry;
          if (requiresValidation) {
            const hasContent = info && (
              info.description ||
              (info.tools && info.tools.length > 0) ||
              (info.toolSummaries && info.toolSummaries.length > 0)
            );
            if (!hasContent) {
              // Inspect returned empty — fall back to browse to check if agent exists
              const registryUrl = entry.sourceRegistry?.url;
              let foundInBrowse = false;
              if (registryUrl) {
                try {
                  const agents = await consumer.browse(registryUrl);
                  const stripAt = (s: string) => s.replace(/^@/, "");
                  const refKey = stripAt(entry.sourceRegistry?.agentPath ?? entry.ref);
                  foundInBrowse = agents.some(
                    (a) => a.path === entry.ref || stripAt(a.path) === refKey,
                  );
                } catch {
                  // browse failed too
                }
              }
              if (!foundInBrowse) {
                const registryHint = registryUrl ?? "your configured registry";
                throw new AdkError({
                  code: "REF_NOT_FOUND",
                  message: `Agent "${entry.ref}" not found on ${registryHint}`,
                  hint: "Check available agents with: adk registry browse",
                  details: { ref: entry.ref, sourceRegistry: entry.sourceRegistry, scheme: entry.scheme },
                });
              }
            }
          }

          if (info?.security) security = info.security;
          const agentMode = (info as any)?.mode;
          if (agentMode) (entry as any).mode = agentMode;
          if (info?.upstream && !entry.url && agentMode !== 'api') {
            entry.url = info.upstream as string;
            entry.scheme = entry.scheme ?? "mcp";
          }
        } catch (err) {
          if (err instanceof AdkError) throw err;
          throw new AdkError({
            code: "REGISTRY_UNREACHABLE",
            message: `Could not reach registry to validate "${entry.ref}"`,
            hint: "Check your registry connection with: adk registry test",
            details: { ref: entry.ref, error: err instanceof Error ? err.message : String(err) },
            cause: err,
          });
        }
      }

      const name = refName(entry);
      const refs = (config.refs ?? []).filter((r) => refName(r) !== name);
      refs.push(entry);
      await writeConfig({ ...config, refs });

      return { security };
    },

    async remove(name: string): Promise<boolean> {
      const config = await readConfig();
      if (!config.refs?.length) return false;
      const before = config.refs.length;
      const refs = config.refs.filter((r) => !refNameMatches(r, name));
      if (refs.length === before) return false;
      await writeConfig({ ...config, refs });
      return true;
    },

    async list(): Promise<ResolvedRef[]> {
      const config = await readConfig();
      return (config.refs ?? []).map(normalizeRef);
    },

    async get(name: string): Promise<RefEntry | null> {
      const config = await readConfig();
      return findRef(config.refs ?? [], name) ?? null;
    },

    async update(name: string, updates: Partial<RefEntry>): Promise<boolean> {
      const config = await readConfig();
      if (!config.refs?.length) return false;
      let found = false;
      const refs = config.refs.map((r): RefEntry => {
        if (!refNameMatches(r, name)) return r;
        found = true;
        const updated = { ...r };
        if (updates.url) updated.url = updates.url;
        if (updates.as) updated.as = updates.as;
        if (updates.scheme) updated.scheme = updates.scheme;
        if (updates.config) updated.config = { ...updated.config, ...updates.config };
        if (updates.sourceRegistry) updated.sourceRegistry = updates.sourceRegistry;
        return updated;
      });
      if (!found) return false;
      await writeConfig({ ...config, refs });
      return true;
    },

    async inspect(name: string, opts?: { full?: boolean }): Promise<AgentListing | null> {
      const config = await readConfig();
      const entry = findRef(config.refs ?? [], name);
      if (!entry) throw new Error(`Ref "${name}" not found`);

      const consumer = await buildConsumerForRef(entry);
      return consumer.inspect(
        entry.sourceRegistry?.agentPath ?? entry.ref,
        entry.sourceRegistry?.url,
        opts,
      );
    },

    async call(name: string, tool: string, params?: Record<string, unknown>): Promise<CallAgentResponse> {
      const config = await readConfig();
      const entry = findRef(config.refs ?? [], name);
      if (!entry) throw new Error(`Ref "${name}" not found`);

      const accessToken = await readRefSecret(name, "access_token");

      // Direct MCP only for redirect/proxy agents with an MCP upstream.
      // API-mode agents must go through the registry (it does REST translation).
      const agentMode = (entry as any).mode ?? 'redirect';
      if (accessToken && entry.url && agentMode !== 'api') {
        return callMcpDirect(entry.url, tool, params ?? {}, accessToken);
      }

      const consumer = await buildConsumerForRef(entry);
      const reg = resolveRegistryForRef(consumer, entry);

      return consumer.callRegistry(reg, {
        action: "execute_tool",
        path: entry.sourceRegistry?.agentPath ?? entry.ref,
        tool,
        params: {
          ...(params ?? {}),
          ...(accessToken && { accessToken }),
        },
      });
    },

    async resources(name: string): Promise<CallAgentResponse> {
      const config = await readConfig();
      const entry = findRef(config.refs ?? [], name);
      if (!entry) throw new Error(`Ref "${name}" not found`);

      const consumer = await buildConsumerForRef(entry);
      const reg = resolveRegistryForRef(consumer, entry);

      return consumer.callRegistry(reg, {
        action: "list_resources",
        path: entry.sourceRegistry?.agentPath ?? entry.ref,
      });
    },

    async read(name: string, uris: string[]): Promise<CallAgentResponse> {
      const config = await readConfig();
      const entry = findRef(config.refs ?? [], name);
      if (!entry) throw new Error(`Ref "${name}" not found`);

      const consumer = await buildConsumerForRef(entry);
      const reg = resolveRegistryForRef(consumer, entry);

      return consumer.callRegistry(reg, {
        action: "read_resources",
        path: entry.sourceRegistry?.agentPath ?? entry.ref,
        uris,
      });
    },

    async authStatus(name: string): Promise<RefAuthStatus> {
      const config = await readConfig();
      const entry = findRef(config.refs ?? [], name);
      if (!entry) throw new Error(`Ref "${name}" not found`);

      let security: SecuritySchemeSummary | null = null;
      try {
        const consumer = await buildConsumerForRef(entry);
        const info = await consumer.inspect(entry.sourceRegistry?.agentPath ?? entry.ref);
        if (info?.security) security = info.security;
      } catch {
        // Can't reach registry
      }

      if (!security || security.type === "none") {
        return { name, security, complete: true, fields: {} };
      }

      const configKeys = Object.keys(entry.config ?? {});
      const resolve = options.resolveCredentials;

      async function canResolve(field: string, oauthMetadata?: import("./mcp-client.js").OAuthServerMetadata | null): Promise<boolean> {
        if (!resolve || !entry) return false;
        const val = await resolve({ ref: name, field, entry, security, oauthMetadata });
        return val !== null;
      }

      const fields: Record<string, CredentialField> = {};

      if (security.type === "oauth2") {
        const securityExt = security as {
          dynamicRegistration?: boolean;
          discoveryUrl?: string;
        };
        const hasRegistration = !!securityExt.dynamicRegistration;

        let oauthMetadata: import("./mcp-client.js").OAuthServerMetadata | null = null;
        let needsSecret = false;
        if (securityExt.discoveryUrl) {
          oauthMetadata = await tryFetchOAuthMetadata(securityExt.discoveryUrl);
          if (oauthMetadata) {
            const authMethods = oauthMetadata.token_endpoint_auth_methods_supported ?? [];
            needsSecret = !authMethods.includes("none");
          }
        }

        fields.client_id = {
          required: true,
          automated: hasRegistration,
          present: configKeys.includes("client_id"),
          resolvable: await canResolve("client_id", oauthMetadata),
        };
        if (needsSecret) {
          fields.client_secret = {
            required: true,
            automated: hasRegistration,
            present: configKeys.includes("client_secret"),
            resolvable: await canResolve("client_secret", oauthMetadata),
          };
        }
        fields.access_token = {
          required: true,
          automated: true,
          present: configKeys.includes("access_token"),
          resolvable: false,
        };
      } else if (security.type === "apiKey") {
        fields.api_key = {
          required: true,
          automated: false,
          present: configKeys.includes("api_key"),
          resolvable: await canResolve("api_key"),
        };
      } else if (security.type === "http") {
        fields.token = {
          required: true,
          automated: false,
          present: configKeys.includes("token"),
          resolvable: await canResolve("token"),
        };
      }

      const complete = Object.values(fields).every(
        (f) => !f.required || f.present || f.resolvable,
      );

      return { name, security, complete, fields };
    },

    async auth(name: string, opts?: {
      apiKey?: string;
      /** Extra context to encode in the OAuth state (e.g., tenant/user IDs for multi-tenant callbacks) */
      stateContext?: Record<string, unknown>;
      /** Additional scopes to request (e.g., optional scopes declared by the agent) */
      scopes?: string[];
    }): Promise<AuthStartResult> {
      const config = await readConfig();
      const entry = findRef(config.refs ?? [], name);
      if (!entry) throw new Error(`Ref "${name}" not found`);

      const status = await ref.authStatus(name);
      const security = status.security;
      const resolve = options.resolveCredentials;

      async function tryResolve(field: string, oauthMetadata?: import("./mcp-client.js").OAuthServerMetadata | null): Promise<string | null> {
        if (!resolve) return null;
        return resolve({ ref: name, field, entry: entry!, security, oauthMetadata });
      }

      if (!security || security.type === "none") {
        return { type: "none", complete: true };
      }

      if (security.type === "apiKey") {
        const key = opts?.apiKey ?? await tryResolve("api_key");
        if (!key) return { type: "apiKey", complete: false };
        await storeRefSecret(name, "api_key", key);
        return { type: "apiKey", complete: true };
      }

      if (security.type === "http") {
        const token = opts?.apiKey ?? await tryResolve("token");
        if (!token) return { type: "http", complete: false };
        await storeRefSecret(name, "token", token);
        return { type: "http", complete: true };
      }

      if (security.type === "oauth2") {
        const flows = (security as { flows?: { authorizationCode?: { authorizationUrl?: string; tokenUrl?: string } } }).flows;
        const authCodeFlow = flows?.authorizationCode;
        if (!authCodeFlow?.authorizationUrl) {
          return { type: "oauth2", complete: false };
        }

        const authUrl = authCodeFlow.authorizationUrl;
        let metadata = await tryFetchOAuthMetadata(authUrl);
        if (!metadata) {
          const origin = new URL(authUrl).origin;
          metadata = await discoverOAuthMetadata(origin);
        }
        // Fallback: construct metadata from the security scheme's explicit URLs
        if (!metadata && authCodeFlow.tokenUrl) {
          const flowScopes = (authCodeFlow as Record<string, unknown>).scopes as Record<string, string> | undefined;
          metadata = {
            issuer: new URL(authUrl).origin,
            authorization_endpoint: authUrl,
            token_endpoint: authCodeFlow.tokenUrl,
            scopes_supported: flowScopes ? Object.keys(flowScopes) : undefined,
          } as import("./mcp-client.js").OAuthServerMetadata;
        }
        if (!metadata) {
          throw new Error(`Could not discover OAuth metadata from ${authUrl}`);
        }

        const redirectUri = callbackUrl();

        // Resolve client credentials: callback → stored → dynamic registration
        let clientId = await tryResolve("client_id", metadata)
          ?? await readRefSecret(name, "client_id");
        let clientSecret = await tryResolve("client_secret", metadata)
          ?? await readRefSecret(name, "client_secret")
          ?? undefined;

        if (!clientId && metadata.registration_endpoint) {
          const supportedAuthMethods = metadata.token_endpoint_auth_methods_supported ?? ["none"];
          const preferredMethod = supportedAuthMethods.includes("none")
            ? "none"
            : supportedAuthMethods[0] ?? "client_secret_post";

          const securityClientName = (security as { clientName?: string }).clientName;
          const reg = await dynamicClientRegistration(metadata.registration_endpoint, {
            clientName: securityClientName ?? options.oauthClientName ?? "adk",
            redirectUris: [redirectUri],
            grantTypes: ["authorization_code"],
            tokenEndpointAuthMethod: preferredMethod,
          });
          clientId = reg.clientId;
          clientSecret = reg.clientSecret;
          await storeRefSecret(name, "client_id", clientId);
          if (clientSecret) {
            await storeRefSecret(name, "client_secret", clientSecret);
          }
        }

        if (!clientId) {
          throw new Error(
            "Could not obtain client_id. Provide via resolveCredentials callback or store manually.",
          );
        }

        // State ties the callback back to this ref. Encode as base64 JSON
        // so callers can include extra context (tenant/user IDs).
        const statePayload = {
          ...opts?.stateContext,
          ref: name,
          ts: Date.now(),
        };
        const state = btoa(JSON.stringify(statePayload));

        const securityExt2 = security as { requiredScopes?: string[]; optionalScopes?: string[] };
        const flowScopes = (authCodeFlow as Record<string, unknown>).scopes as Record<string, string> | undefined;
        const agentScopes = [
          ...(securityExt2.requiredScopes ?? []),
          ...(flowScopes ? Object.keys(flowScopes) : []),
          ...(opts?.scopes ?? []),
        ].filter((v, i, a) => a.indexOf(v) === i);
        const scopes = agentScopes.length > 0
          ? [
              ...agentScopes,
              ...(metadata.scopes_supported?.includes('openid') ? ['openid'] : []),
            ]
          : metadata.scopes_supported;

        const { url: authorizeUrl, codeVerifier } = await buildOAuthAuthorizeUrl({
          authorizationEndpoint: metadata.authorization_endpoint,
          clientId,
          redirectUri,
          scopes,
          state,
        });

        // Persist pending state so handleCallback works across processes
        await storePendingOAuth(state, {
          refName: name,
          codeVerifier,
          clientId,
          clientSecret,
          tokenEndpoint: metadata.token_endpoint,
          redirectUri,
          createdAt: Date.now(),
        });

        return { type: "oauth2", complete: false, authorizeUrl };
      }

      return { type: security.type, complete: false };
    },

    async authLocal(name: string, opts?: {
      onAuthorizeUrl?: (url: string) => void;
      timeoutMs?: number;
    }): Promise<{ complete: boolean }> {
      const result = await ref.auth(name);

      if (result.complete) return { complete: true };
      if (result.type !== "oauth2" || !result.authorizeUrl) {
        throw new Error(`authLocal only handles OAuth2. Auth type: ${result.type}`);
      }

      if (opts?.onAuthorizeUrl) {
        opts.onAuthorizeUrl(result.authorizeUrl);
      }

      // Spin up local callback server
      const port = options.oauthCallbackPort ?? 8919;
      const timeout = opts?.timeoutMs ?? 300_000;

      const { createServer } = await import("node:http");
      return new Promise<{ complete: boolean }>((resolve, reject) => {
        const server = createServer(async (req, res) => {
          const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
          if (reqUrl.pathname !== "/callback") return;

          const code = reqUrl.searchParams.get("code");
          const state = reqUrl.searchParams.get("state");

          if (!code || !state) {
            const error = reqUrl.searchParams.get("error") ?? "missing code/state";
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`<h1>Error</h1><p>${error}</p>`);
            server.close();
            reject(new Error(`OAuth denied: ${error}`));
            return;
          }

          try {
            const cbResult = await handleCallback({ code, state });
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h1>Authorized!</h1><p>You can close this tab.</p>");
            server.close();
            resolve({ complete: cbResult.complete });
          } catch (err) {
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(`<h1>Error</h1><p>${err instanceof Error ? err.message : String(err)}</p>`);
            server.close();
            reject(err);
          }
        });

        server.listen(port);
        const timer = setTimeout(() => {
          server.close();
          reject(new Error("OAuth callback timed out"));
        }, timeout);
        server.on("close", () => clearTimeout(timer));
      });
    },
  };

  // ==========================================
  // Top-level callback handler
  // ==========================================

  async function handleCallback(params: { code: string; state: string }): Promise<{ refName: string; complete: boolean; stateContext?: Record<string, unknown> }> {
    const pending = await consumePendingOAuth(params.state);
    if (!pending) {
      throw new Error(`No pending OAuth flow for state "${params.state}".`);
    }

    const tokens = await exchangeCodeForTokens(pending.tokenEndpoint, {
      code: params.code,
      codeVerifier: pending.codeVerifier,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      redirectUri: pending.redirectUri,
    });

    await storeRefSecret(pending.refName, "access_token", tokens.accessToken);
    if (tokens.refreshToken) {
      await storeRefSecret(pending.refName, "refresh_token", tokens.refreshToken);
    }

    let stateContext: Record<string, unknown> | undefined;
    try {
      stateContext = JSON.parse(atob(params.state));
    } catch { /* state wasn't base64 JSON — legacy format */ }

    return { refName: pending.refName, complete: true, stateContext };
  }

  // ==========================================
  // Proxy API
  // ==========================================

  const proxy: AdkProxyApi = {
    async add(entry: ProxyEntry): Promise<void> {
      const config = await readConfig();
      const proxies = (config.proxies ?? []).filter((p) => p.name !== entry.name);
      proxies.push(entry);
      await writeConfig({ ...config, proxies });
    },

    async remove(name: string): Promise<boolean> {
      const config = await readConfig();
      if (!config.proxies?.length) return false;
      const before = config.proxies.length;
      const proxies = config.proxies.filter((p) => p.name !== name);
      if (proxies.length === before) return false;
      await writeConfig({ ...config, proxies });
      return true;
    },

    async list(): Promise<ProxyEntry[]> {
      const config = await readConfig();
      return config.proxies ?? [];
    },
  };

  return { proxy, registry, ref, readConfig, writeConfig, handleCallback };
}
