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

import { AdkError } from "./adk-error.js";
import type { FsStore } from "./agent-definitions/config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type {
  ConsumerConfig,
  RefAddInput,
  RefEntry,
  RegistryEntry,
  ResolvedRef,
  ResolvedRegistry,
} from "./define-config.js";
import { normalizeRef } from "./define-config.js";
import type { RegistryAuthRequirement } from "./define-config.js";
import type { FetchFn } from "./fetch-types.js";
import type { Logger } from "./logger.js";
import {
  buildOAuthAuthorizeUrl,
  discoverOAuthMetadata,
  dynamicClientRegistration,
  exchangeCodeForTokens,
  probeRegistryAuth,
  refreshAccessToken,
} from "./mcp-client.js";
import { createRegistryConsumer } from "./registry-consumer.js";
import type {
  AgentInspection,
  AgentListEntry,
  RegistryConfiguration,
  RegistryConsumer,
} from "./registry-consumer.js";
import type {
  CallAgentErrorResponse,
  CallAgentExecuteToolResponse,
  CallAgentResponse,
  SecuritySchemeSummary,
} from "./types.js";

const CONFIG_PATH = "consumer-config.json";
const REGISTRY_CACHE_PATH = "registry-cache.json";
const SECRET_PREFIX = "secret:";

// ============================================
// Registry cache types
// ============================================

/**
 * Slim tool summary stored in the registry cache. Mirrors the shape returned
 * by `consumer.inspect()` (sans `inputSchema` and `fullTokens`) so the LLM
 * can discover an agent's surface without a network round-trip.
 */
export interface RegistryCacheToolSummary {
  name: string;
  description?: string;
}

/**
 * Slim auth-field metadata cached so hosts can locally answer "is this
 * ref ready to call?" without a registry round-trip. Mirrors the
 * authoritative shape `auth-status` produces — same source of truth,
 * just persisted.
 *
 * For each field name in the security scheme:
 *   - `required`  — must end up satisfied for `ref.call` to work.
 *   - `automated` — adk fills this in itself (e.g. dynamic OAuth
 *                   client registration). Doesn't need to be `present`
 *                   in the user's config to count as satisfied.
 */
export interface RegistryCacheAuthField {
  required: boolean;
  automated: boolean;
}

/**
 * Per-ref cache entry. Updated as a side-effect of `ref.add()`,
 * `ref.inspect()`, and `ref.authStatus()` whenever the registry
 * response carries description / tool / security-scheme info.
 * Identity-relative (lives next to the consumer-config that issued
 * the registry call), so permission-filtered views stay consistent.
 */
export interface RegistryCacheEntry {
  /** Canonical agent path (e.g. `notion`). Stored for sanity/debug. */
  ref: string;
  description?: string;
  tools?: RegistryCacheToolSummary[];
  /**
   * Auth field requirements derived from the registry's security
   * scheme (extracted by `auth-status`). When present, hosts can
   * compute "is this ref callable?" by intersecting these with the
   * entry's `config` — no network round-trip needed. Absent when the
   * scheme couldn't be fetched (e.g. registry was offline at add
   * time); fall back to whatever heuristic the caller chooses.
   */
  authFields?: Record<string, RegistryCacheAuthField>;
  /** ISO timestamp of the most recent registry round-trip that wrote this. */
  fetchedAt: string;
}

/**
 * On-disk shape of `registry-cache.json`. Keyed by `RefEntry.name` (local
 * identifier) — the same key consumer-config uses, so hydration is a 1:1
 * lookup.
 */
export interface RegistryCache {
  refs: Record<string, RegistryCacheEntry>;
}

/**
 * Options for `isRefAuthComplete`.
 */
export interface RefAuthCompleteOptions {
  /**
   * Field names the consumer can resolve at call time without them
   * being present in `entry.config` — typically OAuth client_id /
   * client_secret resolved from environment variables or platform
   * config by the host's `resolveCredentials` callback.
   *
   * Required-non-automated fields listed here count as satisfied even
   * when missing from `entry.config`. The default behaviour (no opt
   * passed) requires every such field to live in config, which is
   * correct for self-hosted SDK consumers but wrong for platforms
   * that inject OAuth client credentials at runtime.
   */
  resolvableFields?: ReadonlyArray<string>;
}

/**
 * "Is this ref ready to call?" answered locally using the cached
 * security-scheme requirements. Mirrors the `complete` boolean
 * `auth-status` returns, but doesn't need a network round-trip — the
 * cached `authFields` capture what the registry said is required, and
 * we evaluate satisfaction against the entry's current `config`.
 *
 * Behavior:
 *   - Cache miss (no `authFields` for this ref yet) → returns `null`,
 *     signaling "I don't know — caller should fall back to its own
 *     heuristic or call `auth-status` to populate the cache".
 *   - Cache hit → for every required, non-automated field, checks
 *     presence in `entry.config` OR (if `opts.resolvableFields`
 *     includes the field name) treats it as satisfied externally.
 *     Mirrors the `present || resolvable` check in `auth-status`.
 *     `automated` fields (e.g. dynamic OAuth client_id minted by the
 *     registry) always count as satisfied.
 *
 * Returning `null` for cache miss is intentional. A boolean would
 * force callers to choose a default that's wrong half the time;
 * `null` lets them branch explicitly.
 */
export function isRefAuthComplete(
  entry: RefEntry,
  cacheEntry: RegistryCacheEntry | undefined,
  opts?: RefAuthCompleteOptions,
): boolean | null {
  if (typeof entry === "string") return false;
  const authFields = cacheEntry?.authFields;
  if (!authFields) return null;
  const config = entry.config ?? {};
  const resolvable =
    opts?.resolvableFields && opts.resolvableFields.length > 0
      ? new Set(opts.resolvableFields)
      : null;
  for (const [field, info] of Object.entries(authFields)) {
    if (!info.required) continue;
    if (info.automated) continue;
    if (field in config) continue;
    if (resolvable && resolvable.has(field)) continue;
    return false;
  }
  return true;
}

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
   * Default result token limit to pass through for `ref.call` registry requests.
   * Use `null` to explicitly disable remote result limiting for in-process
   * scripting boundaries like `adk run`; omit to use the registry default.
   */
  refCallMaxResultTokens?: number | null;
  /**
   * Default overflow behavior to pass through for `ref.call` registry requests.
   * Only applies when the remote registry enforces a result limit.
   */
  refCallOverflow?: "error" | "truncate" | null;
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
  /**
   * Custom fetch implementation. Forwarded to every `createRegistryConsumer`
   * call spun up internally by the adk (consumer(), available(), registry.test()).
   *
   * Hosts running inside a long-lived server (e.g. atlas) should pass a
   * hardened fetch — one backed by a connection pool with short timeouts,
   * TCP keepalive, and one-shot retry on connection errors — to avoid
   * dead-socket hangs when upstream pods roll. Defaults to `globalThis.fetch`.
   */
  fetch?: FetchFn;
  /**
   * Structured logger. Currently reserved for future use; the adk itself
   * does not emit logs today but may in future versions. Threading this in
   * now lets hosts standardize on a single logger across all sdk surfaces
   * (`createAgentRegistry`, `createAgentServer`, `createAdk`, etc.).
   */
  logger?: Logger;
}

export interface RegistryTestResult {
  name: string;
  url: string;
  status: "active" | "error";
  issuer?: string;
  error?: string;
}

export interface AdkRegistryApi {
  add(
    entry: RegistryEntry,
  ): Promise<{ authRequirement?: RegistryAuthRequirement }>;
  remove(nameOrUrl: string): Promise<boolean>;
  list(): Promise<RegistryEntry[]>;
  get(name: string): Promise<RegistryEntry | null>;
  update(name: string, updates: Partial<RegistryEntry>): Promise<boolean>;
  browse(name: string, query?: string): Promise<AgentListEntry[]>;
  inspect(name: string): Promise<RegistryConfiguration>;
  test(name?: string): Promise<RegistryTestResult[]>;
  /**
   * Attach a credential to a registry that returned 401 during `add`. Clears
   * `authRequirement` so subsequent ops stop throwing `registry_auth_required`.
   * Accepts a pre-existing token / api-key when the caller already has one.
   */
  auth(
    nameOrUrl: string,
    credential:
      | { token: string; tokenUrl?: string }
      | { apiKey: string; header?: string },
  ): Promise<boolean>;

  /**
   * Resolve auth for a registry the way `adk registry auth` does — runs the
   * full OAuth flow (dynamic client registration + PKCE authorize + callback
   * + token exchange) when the registry advertised authorization servers,
   * or spins up a local HTTPS form for bearer-token entry otherwise.
   *
   * Returns `{ complete: true }` once the registry has usable credentials
   * persisted. The `onAuthorizeUrl` callback fires with the URL the user
   * should open (browser redirect URL for OAuth, or `http://localhost/auth`
   * for the token-entry form). Pass `force: true` to skip the short-circuit
   * when existing credentials look syntactically valid but may be stale
   * server-side — the common case when the CLI command is invoked explicitly.
   */
  authLocal(
    nameOrUrl: string,
    opts?: {
      onAuthorizeUrl?: (url: string) => void;
      timeoutMs?: number;
      force?: boolean;
    },
  ): Promise<{ complete: boolean }>;
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

/** A field the caller needs to collect from the user */
export interface AuthChallengeField {
  /** Field key (e.g. "api_key", "token") */
  name: string;
  /** Human-readable label (e.g. "API Key", "DD-API-KEY") */
  label: string;
  /** Whether this is a secret value (should be masked in UI) */
  secret: boolean;
  /** Optional description / help text */
  description?: string;
}

export interface AuthStartResult {
  type: string;
  complete: boolean;
  /** For OAuth: the URL to open in the browser */
  authorizeUrl?: string;
  /**
   * When complete=false and type is "apiKey" or "http",
   * these are the fields the caller should collect from the user.
   * The caller can render these as a form (Slack blocks, web modal, CLI prompts).
   */
  fields?: AuthChallengeField[];
}

export type AdkRefCallResult =
  | CallAgentExecuteToolResponse
  | CallAgentErrorResponse;

function toAdkRefCallResult(result: CallAgentResponse): AdkRefCallResult {
  if (result.success === false) return result;
  if ("result" in result) return result;

  return {
    success: false,
    error: "Expected execute_tool response from ref.call",
    code: "unexpected_ref_call_response",
  };
}

/**
 * Type slot for adk.ref.call() type safety.
 * Empty by default — populated by `adk sync` which generates `adk.d.ts`.
 * When populated, call() rejects unknown agent paths and tool names at compile time.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export type AdkAgentRegistry = {};

/** @internal Helper types for conditional call() signature */
type AgentPath = keyof AdkAgentRegistry;
type ToolsOf<A extends AgentPath> = keyof AdkAgentRegistry[A] & string;
type ParamsOf<
  A extends AgentPath,
  T extends ToolsOf<A>,
> = AdkAgentRegistry[A][T] extends { params: infer P }
  ? P
  : Record<string, unknown>;

type AdkRefCallFn = keyof AdkAgentRegistry extends never
  ? // No registry — loose fallback
    (
      name: string,
      tool: string,
      params?: Record<string, unknown>,
    ) => Promise<AdkRefCallResult>
  : // Registry populated — strict typed overload
    <A extends AgentPath, T extends ToolsOf<A>>(
      name: A,
      tool: T,
      params: ParamsOf<A, T>,
    ) => Promise<AdkRefCallResult>;

export interface AdkRefApi {
  add(entry: RefAddInput): Promise<{ security: SecuritySchemeSummary | null }>;
  remove(name: string): Promise<boolean>;
  list(): Promise<ResolvedRef[]>;
  get(name: string): Promise<ResolvedRef | null>;
  update(name: string, updates: Partial<RefEntry>): Promise<boolean>;
  inspect(
    name: string,
    options?: { full?: boolean },
  ): Promise<AgentInspection | null>;
  call: AdkRefCallFn;
  resources(name: string): Promise<CallAgentResponse>;
  read(name: string, uris: string[]): Promise<CallAgentResponse>;
  /** Check auth status — what's needed vs what's stored */
  authStatus(name: string): Promise<RefAuthStatus>;
  /**
   * Start the auth flow for a ref. Returns the authorize URL for OAuth.
   * Call adk.handleCallback() when the callback arrives, or use
   * adk.ref.authLocal() to spin up a local server and block.
   */
  auth(
    name: string,
    opts?: {
      /** For API key / bearer auth: the key/token value (single-key shorthand) */
      apiKey?: string;
      /**
       * Credentials map for multi-field auth. Keys match the `name` field
       * from AuthChallengeField (e.g. { "api_key": "xxx", "app_key": "yyy" }).
       * For single-key apiKey or http bearer, `apiKey` shorthand also works.
       */
      credentials?: Record<string, string>;
      /** Extra context to encode in the OAuth state (e.g., tenant/user IDs for multi-tenant callbacks) */
      stateContext?: Record<string, unknown>;
      /** Additional scopes to request (e.g., optional scopes declared by the agent) */
      scopes?: string[];
    },
  ): Promise<AuthStartResult>;
  /**
   * Run the full OAuth flow locally: start auth, spin up a callback
   * server, open the browser, wait for the redirect, exchange tokens.
   * Resolves when auth is complete or times out.
   */
  authLocal(
    name: string,
    opts?: {
      /** Called with the authorize URL (e.g. to open in browser) */
      onAuthorizeUrl?: (url: string) => void;
      /** Timeout in ms (default 300_000 = 5 min) */
      timeoutMs?: number;
    },
  ): Promise<{ complete: boolean }>;
  /**
   * Refresh an OAuth access token using a stored refresh_token.
   * Returns the new access_token, or null if refresh is not possible
   * (no refresh_token stored, no tokenUrl, etc.).
   *
   * Use this when a tool call returns 401 to transparently refresh
   * and retry.
   */
  refreshToken(name: string): Promise<{ accessToken: string } | null>;
}

export interface Adk {
  registry: AdkRegistryApi;
  ref: AdkRefApi;
  readConfig(): Promise<ConsumerConfig>;
  writeConfig(config: ConsumerConfig): Promise<void>;
  /**
   * Handle an OAuth callback. Works in any environment.
   * Parse the callback query params and pass them here.
   * @returns the ref name and whether auth is complete
   */
  handleCallback(params: { code: string; state: string }): Promise<{
    refName: string;
    complete: boolean;
    stateContext?: Record<string, unknown>;
  }>;
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
function findRef(refs: RefEntry[], name: string): ResolvedRef | undefined {
  const match = refs.find((r) => refName(r) === name);
  if (match) return normalizeRef(match);
  const alt = name.startsWith("@") ? name.slice(1) : `@${name}`;
  const altMatch = refs.find((r) => refName(r) === alt);
  return altMatch ? normalizeRef(altMatch) : undefined;
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
      result[key] = await decryptSecret(
        value.slice(SECRET_PREFIX.length),
        encryptionKey,
      );
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      result[key] = await decryptConfigSecrets(
        value as Record<string, unknown>,
        encryptionKey,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ============================================
// Factory
// ============================================

/**
 * Check if a tool call response indicates a 401 Unauthorized from the upstream API.
 * Primary: httpStatus set by consumer from HTTP res.status
 * Fallback: _httpStatus from tool result body
 */
function isUnauthorized(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  // Primary: HTTP status forwarded by the registry and set by callRegistry
  if (r.httpStatus === 401) return true;
  // Fallback: _httpStatus in the nested tool result body
  const inner = r.result as Record<string, unknown> | undefined;
  if (inner?._httpStatus === 401) return true;
  return false;
}

// ============================================
// Local auth form HTML
// ============================================

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function renderCredentialForm(
  name: string,
  fields: AuthChallengeField[],
  error?: string,
): string {
  const fieldHtml = fields
    .map(
      (f) => `
      <div class="field">
        <label for="${esc(f.name)}">${esc(f.label)}</label>
        ${f.description ? `<p class="desc">${esc(f.description)}</p>` : ""}
        <input id="${esc(f.name)}" name="${esc(f.name)}" type="${f.secret ? "password" : "text"}" required autocomplete="off" spellcheck="false" />
      </div>`,
    )
    .join("");

  const errorHtml = error ? `<div class="error">${esc(error)}</div>` : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authenticate \u2014 ${esc(name)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#141414;border:1px solid #262626;border-radius:12px;padding:32px;width:100%;max-width:420px}
h1{font-size:20px;font-weight:600;color:#fafafa;margin-bottom:4px}
.sub{font-size:14px;color:#a3a3a3;margin-bottom:24px}
.field{margin-bottom:16px}
label{display:block;font-size:13px;font-weight:500;color:#d4d4d4;margin-bottom:6px}
.desc{font-size:12px;color:#737373;margin-bottom:6px}
input{width:100%;padding:10px 12px;background:#0a0a0a;border:1px solid #333;border-radius:8px;color:#fafafa;font-size:14px;font-family:'SF Mono',Menlo,Consolas,monospace;outline:none;transition:border-color .15s}
input:focus{border-color:#3b82f6}
button{width:100%;padding:10px;background:#f5f5f5;color:#0a0a0a;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px;transition:background .15s}
button:hover{background:#e5e5e5}
.error{font-size:13px;color:#f87171;margin-bottom:16px;padding:10px 12px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);border-radius:8px}
</style></head><body>
<div class="card">
  <h1>Authenticate</h1>
  <p class="sub">${esc(name)}</p>
  ${errorHtml}
  <form method="POST">${fieldHtml}
    <button type="submit">Authenticate</button>
  </form>
</div>
</body></html>`;
}

function renderAuthSuccess(name: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authenticated \u2014 ${esc(name)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#141414;border:1px solid #262626;border-radius:12px;padding:32px 48px;width:100%;max-width:420px;text-align:center}
.icon{font-size:48px;margin-bottom:16px;color:#22c55e}
h1{font-size:20px;font-weight:600;color:#fafafa;margin-bottom:4px}
p{font-size:14px;color:#a3a3a3}
</style></head><body>
<div class="card">
  <div class="icon">&#10003;</div>
  <h1>Authenticated</h1>
  <p>${esc(name)} is ready to use. You can close this tab.</p>
</div>
</body></html>`;
}

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

  // -------------------------------------------------------------------------
  // Registry cache helpers
  //
  // The cache is purely an internal optimization for the adk's read paths
  // (`ref.list()`, `ref.get()`). Writes happen as side-effects of methods
  // that already call the registry (`ref.add()`, `ref.inspect()`); the
  // public surface never grows new methods. Cache failures (missing file,
  // malformed JSON, fs errors during write) are swallowed so the registry
  // cache can never break a registry operation.
  // -------------------------------------------------------------------------

  async function readRegistryCache(): Promise<RegistryCache> {
    try {
      const content = await fs.readFile(REGISTRY_CACHE_PATH);
      if (!content) return { refs: {} };
      const parsed = JSON.parse(content) as RegistryCache;
      return { refs: parsed.refs ?? {} };
    } catch {
      return { refs: {} };
    }
  }

  async function writeRegistryCache(cache: RegistryCache): Promise<void> {
    try {
      await fs.writeFile(REGISTRY_CACHE_PATH, JSON.stringify(cache, null, 2));
    } catch {
      // Best-effort. A failed cache write should never break the operation
      // that triggered it.
    }
  }

  /**
   * Project an inspect/list response into the slim shape we cache. Drops
   * `inputSchema` (too large) and `fullTokens` (registry-internal). Returns
   * undefined if the response carries nothing worth caching.
   */
  function buildCacheEntry(
    ref: string,
    info:
      | {
          description?: string;
          tools?: Array<{ name: string; description?: string }>;
          toolSummaries?: Array<{ name: string; description?: string }>;
        }
      | null
      | undefined,
  ): RegistryCacheEntry | undefined {
    if (!info) return undefined;
    const toolSource = info.tools ?? info.toolSummaries;
    const tools = toolSource?.map((t) => {
      const slim: RegistryCacheToolSummary = { name: t.name };
      if (t.description !== undefined) slim.description = t.description;
      return slim;
    });
    if (info.description === undefined && (!tools || tools.length === 0)) {
      return undefined;
    }
    const entry: RegistryCacheEntry = {
      ref,
      fetchedAt: new Date().toISOString(),
    };
    if (info.description !== undefined) entry.description = info.description;
    if (tools && tools.length > 0) entry.tools = tools;
    return entry;
  }

  async function upsertRegistryCacheEntry(
    name: string,
    entry: RegistryCacheEntry | undefined,
  ): Promise<void> {
    if (!entry) return;
    const cache = await readRegistryCache();
    cache.refs[name] = entry;
    await writeRegistryCache(cache);
  }

  /**
   * Merge `authFields` into an existing cache entry without clobbering
   * description/tools, or create a minimal entry if one doesn't exist
   * yet. Called from `authStatus` so the slim {required, automated}
   * shape is always available for `isRefAuthComplete` to answer
   * locally on subsequent calls.
   */
  async function upsertRegistryCacheAuthFields(
    name: string,
    ref: string,
    authFields: Record<string, RegistryCacheAuthField>,
  ): Promise<void> {
    const cache = await readRegistryCache();
    const existing = cache.refs[name];
    cache.refs[name] = {
      ...(existing ?? { ref, fetchedAt: new Date().toISOString() }),
      authFields,
      // Refresh fetchedAt so freshness telemetry stays accurate.
      fetchedAt: new Date().toISOString(),
    };
    await writeRegistryCache(cache);
  }

  async function removeRegistryCacheEntry(name: string): Promise<void> {
    const cache = await readRegistryCache();
    if (!(name in cache.refs)) return;
    delete cache.refs[name];
    await writeRegistryCache(cache);
  }

  /**
   * Hydrate a `ResolvedRef` with cached registry metadata when available.
   * Pure: never mutates input. Leaves `description` / `tools` undefined when
   * the cache has no entry, so callers can apply their own UX fallback.
   */
  function hydrateFromCache(
    ref: ResolvedRef,
    cache: RegistryCache,
  ): ResolvedRef {
    const cached = cache.refs[ref.name];
    if (!cached) return ref;
    const next: ResolvedRef = { ...ref };
    if (cached.description !== undefined) next.description = cached.description;
    if (cached.tools !== undefined) next.tools = cached.tools;
    return next;
  }

  /**
   * Store a secret value in a ref's config, encrypted if encryptionKey is set.
   * The value is stored inline as "secret:<encrypted>" in consumer-config.json.
   */
  async function storeRefSecret(
    name: string,
    key: string,
    value: string,
  ): Promise<void> {
    const stored = options.encryptionKey
      ? `${SECRET_PREFIX}${await encryptSecret(value, options.encryptionKey)}`
      : value;
    const config = await readConfig();
    const refs = (config.refs ?? []).map((r): RefEntry => {
      if (refName(r) !== name) return r;
      const normalized = normalizeRef(r);
      return { ...normalized, config: { ...normalized.config, [key]: stored } };
    });
    await writeConfig({ ...config, refs });
  }

  async function readRefSecret(
    name: string,
    key: string,
  ): Promise<string | null> {
    const config = await readConfig();
    const entry = findRef(config.refs ?? [], name);
    const value = entry?.config?.[key];
    if (typeof value !== "string") return null;
    if (value.startsWith(SECRET_PREFIX)) {
      // Encrypted credential. Refuse to forward the ciphertext verbatim;
      // upstreams will silently reject `secret:...` as a bearer token
      // and the cause becomes invisible.
      if (!options.encryptionKey) {
        throw new AdkError({
          code: "encryption_key_missing",
          message: `ref.call(${name}): credential "${key}" is encrypted (secret:...) but this Adk instance was constructed without an encryptionKey.`,
          hint: "Pass `encryptionKey` when constructing the Adk (createAdk/createAdkForUser/createAdkForTenant).",
          details: { ref: name, field: key },
        });
      }
      try {
        return await decryptSecret(
          value.slice(SECRET_PREFIX.length),
          options.encryptionKey,
        );
      } catch (err) {
        throw new AdkError({
          code: "encryption_key_mismatch",
          message: `ref.call(${name}): failed to decrypt credential "${key}". The configured encryptionKey does not match the key used to encrypt this value.`,
          hint: "Re-encrypt the ref's credentials with the current encryptionKey, or restore the previous key.",
          details: { ref: name, field: key, cause: (err as Error)?.message },
        });
      }
    }
    return value;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Credential resolution helpers
  //
  // Three callsites used to inline a `tryResolve`/`canResolve` closure
  // (auth, authStatus, refreshToken) and two of them duplicated the
  // client_id/client_secret lookup chain verbatim. Those chains MUST stay
  // symmetric — if `auth` accepts a credential source, `refreshToken` has
  // to read from the same source or refresh silently no-ops on every ref
  // `auth` succeeded against. Centralising it here removes that drift
  // risk.
  // ─────────────────────────────────────────────────────────────────────

  type OAuthServerMetadata = import("./mcp-client.js").OAuthServerMetadata;

  interface CredentialResolverContext {
    name: string;
    entry: RefEntry;
    security: SecuritySchemeSummary | null;
  }

  /**
   * Build a `tryResolve(field, oauthMetadata?)` function bound to a
   * specific ref + entry + security context. Wraps the host-injected
   * `resolveCredentials` callback (e.g. atlas's env/static/tenant chain
   * for first-party agents). Errors propagate to the caller.
   */
  function makeTryResolve(ctx: CredentialResolverContext) {
    return async (
      field: string,
      oauthMetadata?: OAuthServerMetadata | null,
    ): Promise<string | null> => {
      const resolve = options.resolveCredentials;
      if (!resolve) return null;
      return resolve({
        ref: ctx.name,
        field,
        entry: ctx.entry,
        security: ctx.security,
        oauthMetadata,
      });
    };
  }

  /**
   * Resolve OAuth client credentials (client_id + client_secret) for a
   * ref. Walks: `resolveCredentials` callback → per-ref VCS storage.
   * Used by both `auth` (initial OAuth flow) and `refreshToken` (token
   * refresh) — must be a single function so the two paths can never
   * disagree about where credentials live.
   *
   * Returns null when no client_id is available anywhere; caller decides
   * whether to attempt dynamic registration (`auth`) or bail (`refresh`).
   */
  async function resolveOAuthClient(
    ctx: CredentialResolverContext & { metadata?: OAuthServerMetadata | null },
  ): Promise<{ clientId: string; clientSecret?: string } | null> {
    const tryResolve = makeTryResolve(ctx);
    const clientId =
      (await tryResolve("client_id", ctx.metadata)) ??
      (await readRefSecret(ctx.name, "client_id"));
    if (!clientId) return null;
    const clientSecret =
      (await tryResolve("client_secret", ctx.metadata)) ??
      (await readRefSecret(ctx.name, "client_secret")) ??
      undefined;
    return { clientId, ...(clientSecret && { clientSecret }) };
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

  async function readPendingOAuth(): Promise<
    Record<string, PendingOAuthState>
  > {
    const content = await fs.readFile(PENDING_OAUTH_PATH);
    if (!content) return {};
    try {
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  async function writePendingOAuth(
    pending: Record<string, PendingOAuthState>,
  ): Promise<void> {
    await fs.writeFile(PENDING_OAUTH_PATH, JSON.stringify(pending, null, 2));
  }

  async function storePendingOAuth(
    state: string,
    data: PendingOAuthState,
  ): Promise<void> {
    const pending = await readPendingOAuth();
    pending[state] = data;
    await writePendingOAuth(pending);
  }

  async function consumePendingOAuth(
    state: string,
  ): Promise<PendingOAuthState | null> {
    const pending = await readPendingOAuth();
    const data = pending[state] ?? null;
    if (data) {
      delete pending[state];
      await writePendingOAuth(pending);
    }
    return data;
  }

  /**
   * Error thrown by `callMcpDirect` when the upstream MCP server returns a
   * non-2xx HTTP response. Carries the numeric `status` so the catch handler
   * can surface it as `httpStatus` on the returned CallAgentResponse, which
   * `isUnauthorized` (and the retry-on-401 path in `ref.call`) relies on.
   */
  class McpHttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "McpHttpError";
      this.status = status;
    }
  }

  /** Call an MCP server directly (bypasses registry). */
  async function callMcpDirect(
    serverUrl: string,
    toolName: string,
    params: Record<string, unknown>,
    token: string,
    extraHeaders?: Record<string, string>,
  ): Promise<CallAgentResponse> {
    const url = serverUrl.replace(/\/$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token && !extraHeaders && { Authorization: `Bearer ${token}` }),
      ...extraHeaders,
    };

    let reqId = 0;
    let sessionId: string | undefined;
    async function rpc(method: string, rpcParams?: Record<string, unknown>) {
      const reqHeaders = {
        ...headers,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      };
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
        throw new McpHttpError(
          res.status,
          `MCP ${method} failed (${res.status}): ${await res.text().catch(() => "unknown")}`,
        );
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
                if (json.error)
                  throw new Error(`MCP RPC error: ${json.error.message}`);
                return json.result;
              }
            } catch (e) {
              if (e instanceof Error && e.message.startsWith("MCP RPC"))
                throw e;
            }
          }
        }
        return undefined;
      }

      const json = (await res.json()) as {
        result?: unknown;
        error?: { message: string };
      };
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

      const result = (await rpc("tools/call", {
        name: toolName,
        arguments: params,
      })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };

      const textContent = result?.content?.find((c) => c.type === "text");
      if (textContent?.text) {
        try {
          return {
            success: true,
            result: JSON.parse(textContent.text),
          } as CallAgentResponse;
        } catch {
          return {
            success: true,
            result: textContent.text,
          } as CallAgentResponse;
        }
      }
      return { success: true, result } as CallAgentResponse;
    } catch (err) {
      // Preserve upstream HTTP status (notably 401) so `isUnauthorized`
      // can detect it and trigger the auto-refresh-and-retry path in
      // `ref.call`. Without this, refs that go through callMcpDirect
      // (mode: redirect/proxy with an MCP url, e.g. Linear, Notion) see
      // their tokens expire and fail with a raw 401 instead of silently
      // refreshing the way API-mode refs (Google, etc.) do via the
      // registry's structured response. We attach httpStatus as an
      // out-of-band field on the error envelope, matching the shape
      // `isUnauthorized` already checks for on registry-mediated calls.
      const errorResponse = {
        success: false as const,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof McpHttpError && { httpStatus: err.status }),
      };
      return errorResponse as unknown as CallAgentResponse;
    }
  }

  function callbackUrl(): string {
    const port = options.oauthCallbackPort ?? 8919;
    return options.oauthCallbackUrl ?? `http://localhost:${port}/callback`;
  }

  /** Try fetching a URL directly as OAuth metadata (it may already be a discovery URL). */
  async function tryFetchOAuthMetadata(
    url: string,
  ): Promise<import("./mcp-client.js").OAuthServerMetadata | null> {
    try {
      const res = await globalThis.fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
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
      { token: options.token, fetch: options.fetch },
    );
  }

  /**
   * Build a consumer that includes the ref's sourceRegistry if present.
   * This ensures calls/inspect route to the correct registry endpoint.
   */
  async function buildConsumerForRef(
    entry: RefEntry,
  ): Promise<RegistryConsumer> {
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
      { token: options.token, fetch: options.fetch },
    );
  }

  /**
   * Resolve the correct registry for a ref.
   * If the ref has a sourceRegistry, use that; otherwise fall back to the first registry.
   */
  function resolveRegistryForRef(
    consumer: RegistryConsumer,
    entry: RefEntry,
  ): ResolvedRegistry {
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

  /**
   * Encrypt with `secret:` prefix when an encryption key is configured, so the
   * value is readable by the existing `decryptConfigSecrets` path on the read
   * side. Plaintext fallback preserves the "no key = dev mode" contract.
   */
  async function protectSecret(value: string): Promise<string> {
    if (!options.encryptionKey) return value;
    return `${SECRET_PREFIX}${await encryptSecret(value, options.encryptionKey)}`;
  }

  /**
   * Atomic read-modify-write on a registry entry by name or URL. Used by
   * `authLocal` to persist both `auth` and `oauth` together, which `auth()`
   * alone can't express. Returns true when the entry was found and written.
   */
  async function updateRegistryEntry(
    nameOrUrl: string,
    mutate: (entry: RegistryEntry) => void,
  ): Promise<boolean> {
    const config = await readConfig();
    if (!config.registries?.length) return false;
    let found = false;
    const registries = config.registries.map((r): string | RegistryEntry => {
      const rName = registryDisplayName(r);
      if (rName !== nameOrUrl && registryUrl(r) !== nameOrUrl) return r;
      found = true;
      const existing: RegistryEntry =
        typeof r === "string" ? { url: r } : { ...r };
      mutate(existing);
      return existing;
    });
    if (!found) return false;
    await writeConfig({ ...config, registries });
    return true;
  }

  /**
   * Decrypt a `secret:`-prefixed value if we hold the encryption key. Plaintext
   * values pass through unchanged so dev configs keep working.
   */
  async function revealSecret(
    value: string | undefined,
  ): Promise<string | undefined> {
    if (!value) return value;
    if (!value.startsWith(SECRET_PREFIX)) return value;
    if (!options.encryptionKey) return undefined;
    return decryptSecret(
      value.slice(SECRET_PREFIX.length),
      options.encryptionKey,
    );
  }

  /**
   * Refresh a registry's OAuth access token using the stored refresh token.
   * Persists the new access token (encrypted) and updates `expiresAt`. If the
   * provider rotates the refresh token, that's encrypted and stored too.
   * Returns `true` when the refresh succeeded. Callers should catch and fall
   * back to full re-auth on failure.
   */
  async function refreshRegistryToken(nameOrUrl: string): Promise<boolean> {
    const config = await readConfig();
    const target = findRegistry(config.registries ?? [], nameOrUrl);
    if (!target || typeof target === "string") return false;
    const oauth = target.oauth;
    if (!oauth?.refreshToken || !oauth.tokenEndpoint || !oauth.clientId)
      return false;

    const refreshToken = await revealSecret(oauth.refreshToken);
    const clientSecret = await revealSecret(oauth.clientSecret);
    if (!refreshToken) return false;

    const refreshed = await refreshAccessToken(oauth.tokenEndpoint, {
      refreshToken,
      clientId: oauth.clientId,
      ...(clientSecret && { clientSecret }),
    });

    const expiresAt = refreshed.expiresIn
      ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
      : undefined;
    const encAccess = await protectSecret(refreshed.accessToken);
    const encRefresh = refreshed.refreshToken
      ? await protectSecret(refreshed.refreshToken)
      : undefined;

    await updateRegistryEntry(nameOrUrl, (existing) => {
      existing.auth = { type: "bearer", token: encAccess };
      if (!existing.oauth) return;
      if (encRefresh) existing.oauth.refreshToken = encRefresh;
      if (expiresAt) existing.oauth.expiresAt = expiresAt;
      else delete existing.oauth.expiresAt;
    });
    return true;
  }

  /**
   * Run a registry op once; on 401 (`registry_auth_required`), try to refresh
   * via the stored refresh token and retry exactly once. Any other AdkError
   * propagates as-is.
   */
  async function callWithRefresh<T>(
    nameOrUrl: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof AdkError) || err.code !== "registry_auth_required")
        throw err;
      let refreshed = false;
      try {
        refreshed = await refreshRegistryToken(nameOrUrl);
      } catch {
        // Refresh failed — surface the original 401 below.
      }
      if (!refreshed) throw err;
      return fn();
    }
  }

  /**
   * Throw a typed error if the registry has a recorded auth challenge and
   * no usable credentials on the entry. Callers should invoke this before
   * running any op that talks to the registry.
   */
  function assertRegistryAuthorized(entry: RegistryEntry): void {
    if (!entry.authRequirement) return;
    const hasUsableAuth =
      entry.auth && entry.auth.type !== "none"
        ? (entry.auth.type === "bearer" && !!entry.auth.token) ||
          (entry.auth.type === "api-key" && !!entry.auth.key)
        : false;
    if (hasUsableAuth) return;

    const name = entry.name ?? entry.url;
    const scope = entry.authRequirement.scopes?.join(" ");
    throw new AdkError({
      code: "registry_auth_required",
      message: `Registry "${name}" requires authentication.`,
      hint: `Run: adk registry auth ${name} --token <token>${scope ? ` (scopes: ${scope})` : ""}`,
      details: {
        url: entry.url,
        scheme: entry.authRequirement.scheme,
        realm: entry.authRequirement.realm,
        authorizationServers: entry.authRequirement.authorizationServers,
        scopes: entry.authRequirement.scopes,
        resourceMetadataUrl: entry.authRequirement.resourceMetadataUrl,
      },
    });
  }

  const registry: AdkRegistryApi = {
    async add(
      entry: RegistryEntry,
    ): Promise<{ authRequirement?: RegistryAuthRequirement }> {
      const config = await readConfig();
      const alias = entry.name ?? entry.url;
      const registries = (config.registries ?? []).filter(
        (r) => registryDisplayName(r) !== alias,
      );

      // Probe the registry before saving. If it returns 401 with a
      // WWW-Authenticate / RFC 9728 resource metadata pointer, persist
      // that on `authRequirement` so subsequent ops can refuse early
      // with a friendly message.
      let final: RegistryEntry = entry;
      let authRequirement: RegistryAuthRequirement | undefined;

      const hasUsableAuth =
        entry.auth && entry.auth.type !== "none"
          ? (entry.auth.type === "bearer" && !!entry.auth.token) ||
            (entry.auth.type === "api-key" && !!entry.auth.key)
          : false;

      if (!hasUsableAuth) {
        const fetchFn = options.fetch ?? globalThis.fetch;
        const probe = await probeRegistryAuth(entry.url, fetchFn);
        if (probe.ok === false) {
          authRequirement = probe.requirement;
          final = { ...final, authRequirement };
        }
      }

      registries.push(final);
      await writeConfig({ ...config, registries });
      return authRequirement ? { authRequirement } : {};
    },

    async remove(nameOrUrl: string): Promise<boolean> {
      const config = await readConfig();
      if (!config.registries?.length) return false;
      const before = config.registries.length;
      const registries = config.registries.filter(
        (r) =>
          registryDisplayName(r) !== nameOrUrl && registryUrl(r) !== nameOrUrl,
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

    async update(
      name: string,
      updates: Partial<RegistryEntry>,
    ): Promise<boolean> {
      const config = await readConfig();
      if (!config.registries?.length) return false;
      let found = false;
      const registries = config.registries.map((r): string | RegistryEntry => {
        const rName = registryDisplayName(r);
        if (rName !== name && registryUrl(r) !== name) return r;
        found = true;
        const existing: RegistryEntry =
          typeof r === "string" ? { url: r } : { ...r };
        if (updates.url) existing.url = updates.url;
        if (updates.name) existing.name = updates.name;
        if (updates.auth) existing.auth = updates.auth;
        if (updates.headers)
          existing.headers = { ...existing.headers, ...updates.headers };
        return existing;
      });
      if (!found) return false;
      await writeConfig({ ...config, registries });
      return true;
    },

    async browse(name: string, query?: string): Promise<AgentListEntry[]> {
      const config = await readConfig();
      const target = findRegistry(config.registries ?? [], name);
      if (target && typeof target !== "string")
        assertRegistryAuthorized(target);
      return callWithRefresh(name, async () => {
        const consumer = await buildConsumer(name);
        const url = target ? registryUrl(target) : name;
        return consumer.browse(url, query);
      });
    },

    async inspect(name: string): Promise<RegistryConfiguration> {
      const config = await readConfig();
      const target = findRegistry(config.registries ?? [], name);
      if (target && typeof target !== "string")
        assertRegistryAuthorized(target);
      return callWithRefresh(name, async () => {
        const consumer = await buildConsumer(name);
        const url = target ? registryUrl(target) : name;
        return consumer.discover(url);
      });
    },

    async test(name?: string): Promise<RegistryTestResult[]> {
      const config = await readConfig();
      const registries = config.registries ?? [];
      const targets = name
        ? registries.filter(
            (r) => registryDisplayName(r) === name || registryUrl(r) === name,
          )
        : registries;

      const results = await Promise.allSettled(
        targets.map(async (r): Promise<RegistryTestResult> => {
          const url = registryUrl(r);
          const rName = registryDisplayName(r);
          if (typeof r !== "string" && r.authRequirement) {
            const hasUsableAuth =
              r.auth && r.auth.type !== "none"
                ? (r.auth.type === "bearer" && !!r.auth.token) ||
                  (r.auth.type === "api-key" && !!r.auth.key)
                : false;
            if (!hasUsableAuth) {
              return {
                name: rName,
                url,
                status: "error",
                error: `auth required — run: adk registry auth ${rName} --token <token>`,
              };
            }
          }
          try {
            // Route through buildConsumer so encrypted auth/headers get
            // decrypted, then use callWithRefresh so a 401 triggers the
            // stored refresh token before giving up.
            const disc = await callWithRefresh(rName, async () => {
              const consumer = await buildConsumer(rName);
              return consumer.discover(url);
            });
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
          : {
              name: "unknown",
              url: "unknown",
              status: "error" as const,
              error: "unknown",
            },
      );
    },

    async auth(
      nameOrUrl: string,
      credential:
        | { token: string; tokenUrl?: string }
        | { apiKey: string; header?: string },
    ): Promise<boolean> {
      // Encrypt the secret value up-front so the write path is uniform;
      // `buildConsumer` decrypts on the read side via `decryptConfigSecrets`.
      const protectedValue =
        "token" in credential
          ? await protectSecret(credential.token)
          : await protectSecret(credential.apiKey);

      const updated = await updateRegistryEntry(nameOrUrl, (existing) => {
        if ("token" in credential) {
          existing.auth = {
            type: "bearer",
            token: protectedValue,
            ...(credential.tokenUrl && { tokenUrl: credential.tokenUrl }),
          };
        } else {
          existing.auth = {
            type: "api-key",
            key: protectedValue,
            ...(credential.header && { header: credential.header }),
          };
        }
        delete existing.authRequirement;
      });
      return updated;
    },

    async authLocal(
      nameOrUrl: string,
      opts?: {
        onAuthorizeUrl?: (url: string) => void;
        timeoutMs?: number;
        force?: boolean;
      },
    ): Promise<{ complete: boolean }> {
      const config = await readConfig();
      const target = findRegistry(config.registries ?? [], nameOrUrl);
      if (!target || typeof target === "string") {
        throw new AdkError({
          code: "registry_not_found",
          message: `Registry not found: ${nameOrUrl}`,
          hint: "Run `adk registry list` to see configured registries.",
          details: { nameOrUrl },
        });
      }

      // When the caller forces re-auth, wipe the existing credentials and
      // re-probe so we know what scheme the registry wants now. Servers can
      // rotate auth server metadata between runs.
      if (opts?.force) {
        await updateRegistryEntry(nameOrUrl, (existing) => {
          delete existing.auth;
          delete existing.oauth;
        });
        const fetchFn = options.fetch ?? globalThis.fetch;
        const probe = await probeRegistryAuth(target.url, fetchFn);
        if (probe.ok === false) {
          await updateRegistryEntry(nameOrUrl, (existing) => {
            existing.authRequirement = probe.requirement;
          });
          // Re-read so the flow below sees the fresh requirement.
          const refreshed = await readConfig();
          const refreshedTarget = findRegistry(
            refreshed.registries ?? [],
            nameOrUrl,
          );
          if (refreshedTarget && typeof refreshedTarget !== "string") {
            Object.assign(target, refreshedTarget);
          }
        } else if (probe.ok === true) {
          // Registry no longer requires auth — nothing to do.
          await updateRegistryEntry(nameOrUrl, (existing) => {
            delete existing.authRequirement;
          });
          return { complete: true };
        }
      }

      // Already authenticated — nothing to do (unless forced above).
      const hasUsableAuth =
        target.auth && target.auth.type !== "none"
          ? (target.auth.type === "bearer" && !!target.auth.token) ||
            (target.auth.type === "api-key" && !!target.auth.key)
          : false;
      if (hasUsableAuth && !target.authRequirement) {
        return { complete: true };
      }

      const req = target.authRequirement;
      const port = options.oauthCallbackPort ?? 8919;
      const timeout = opts?.timeoutMs ?? 300_000;
      const displayName = target.name ?? target.url;
      const { createServer } = await import("node:http");

      // OAuth path — the registry advertised authorization servers via
      // RFC 9728 protected-resource metadata. Walk the full flow:
      // AS metadata → dynamic client registration → PKCE authorize →
      // local callback → token exchange → persist access token.
      if (req?.authorizationServers?.length) {
        const authServer = req.authorizationServers[0]!;
        const metadata =
          (await discoverOAuthMetadata(authServer)) ??
          (await tryFetchOAuthMetadata(authServer));
        if (!metadata) {
          throw new AdkError({
            code: "registry_oauth_discovery_failed",
            message: `Could not discover OAuth metadata at ${authServer}.`,
            hint: "The authorization server must expose /.well-known/oauth-authorization-server.",
            details: { authServer, registry: displayName },
          });
        }
        if (!metadata.registration_endpoint) {
          throw new AdkError({
            code: "registry_oauth_no_registration",
            message: `Authorization server ${authServer} does not support dynamic client registration.`,
            hint: `Obtain a bearer token manually, then run: adk registry auth ${displayName} --token <token>`,
            details: { authServer, registry: displayName },
          });
        }

        const redirectUri = `http://localhost:${port}/callback`;
        const registration = await dynamicClientRegistration(
          metadata.registration_endpoint,
          {
            clientName: options.oauthClientName ?? "adk",
            redirectUris: [redirectUri],
            grantTypes: ["authorization_code"],
          },
        );

        const state = crypto.randomUUID();
        const { url: authorizeUrl, codeVerifier } =
          await buildOAuthAuthorizeUrl({
            authorizationEndpoint: metadata.authorization_endpoint,
            clientId: registration.clientId,
            redirectUri,
            scopes: req.scopes,
            state,
          });

        return new Promise<{ complete: boolean }>((resolve, reject) => {
          const server = createServer(async (reqIn, resOut) => {
            const reqUrl = new URL(
              reqIn.url ?? "/",
              `http://localhost:${port}`,
            );
            if (reqUrl.pathname !== "/callback") {
              resOut.writeHead(404);
              resOut.end();
              return;
            }

            const code = reqUrl.searchParams.get("code");
            const returnedState = reqUrl.searchParams.get("state");
            if (!code || returnedState !== state) {
              const error =
                reqUrl.searchParams.get("error") ?? "missing code/state";
              resOut.writeHead(400, { "Content-Type": "text/html" });
              resOut.end(`<h1>Error</h1><p>${esc(error)}</p>`);
              server.close();
              reject(
                new AdkError({
                  code: "registry_oauth_denied",
                  message: `OAuth callback rejected: ${error}`,
                  hint: "Retry `adk registry auth` and complete the browser consent.",
                  details: { registry: displayName, error },
                }),
              );
              return;
            }

            try {
              const tokens = await exchangeCodeForTokens(
                metadata.token_endpoint,
                {
                  code,
                  codeVerifier,
                  clientId: registration.clientId,
                  clientSecret: registration.clientSecret,
                  redirectUri,
                },
              );
              const expiresAt = tokens.expiresIn
                ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
                : undefined;
              const encToken = await protectSecret(tokens.accessToken);
              const encRefresh = tokens.refreshToken
                ? await protectSecret(tokens.refreshToken)
                : undefined;
              const encClientSecret = registration.clientSecret
                ? await protectSecret(registration.clientSecret)
                : undefined;
              await updateRegistryEntry(displayName, (existing) => {
                existing.auth = { type: "bearer", token: encToken };
                existing.oauth = {
                  tokenEndpoint: metadata.token_endpoint,
                  clientId: registration.clientId,
                  ...(encClientSecret && { clientSecret: encClientSecret }),
                  ...(encRefresh && { refreshToken: encRefresh }),
                  ...(expiresAt && { expiresAt }),
                  ...(req.scopes?.length && { scopes: req.scopes }),
                };
                delete existing.authRequirement;
              });
              resOut.writeHead(200, { "Content-Type": "text/html" });
              resOut.end(renderAuthSuccess(displayName));
              server.close();
              resolve({ complete: true });
            } catch (err) {
              resOut.writeHead(500, { "Content-Type": "text/html" });
              resOut.end(
                `<h1>Error</h1><p>${esc(err instanceof Error ? err.message : String(err))}</p>`,
              );
              server.close();
              reject(err);
            }
          });

          server.listen(port, () => {
            opts?.onAuthorizeUrl?.(authorizeUrl);
          });

          const timer = setTimeout(() => {
            server.close();
            reject(new Error("OAuth callback timed out"));
          }, timeout);
          server.on("close", () => clearTimeout(timer));
        });
      }

      // No OAuth metadata — serve a local HTTPS form asking for a token.
      // Used when the registry returned 401 without pointing at an AS, or
      // when the caller simply wants to paste a pre-issued token.
      const fields: AuthChallengeField[] = [
        {
          name: "token",
          label: "Bearer token",
          description: req?.realm
            ? `Token for realm "${req.realm}"`
            : "Token sent as `Authorization: Bearer <token>`.",
          secret: true,
        },
      ];

      return new Promise<{ complete: boolean }>((resolve, reject) => {
        const server = createServer(async (reqIn, resOut) => {
          const reqUrl = new URL(reqIn.url ?? "/", `http://localhost:${port}`);

          if (reqIn.method === "GET" && reqUrl.pathname === "/auth") {
            resOut.writeHead(200, { "Content-Type": "text/html" });
            resOut.end(renderCredentialForm(displayName, fields));
            return;
          }

          if (reqIn.method === "POST" && reqUrl.pathname === "/auth") {
            const chunks: Buffer[] = [];
            for await (const chunk of reqIn) chunks.push(chunk as Buffer);
            const body = Buffer.concat(chunks).toString();
            const params = new URLSearchParams(body);
            const token = params.get("token");
            if (!token) {
              resOut.writeHead(200, { "Content-Type": "text/html" });
              resOut.end(
                renderCredentialForm(displayName, fields, "Token is required."),
              );
              return;
            }
            try {
              await registry.auth(displayName, { token });
              resOut.writeHead(200, { "Content-Type": "text/html" });
              resOut.end(renderAuthSuccess(displayName));
              server.close();
              resolve({ complete: true });
            } catch (err) {
              resOut.writeHead(500, { "Content-Type": "text/html" });
              resOut.end(
                renderCredentialForm(
                  displayName,
                  fields,
                  err instanceof Error ? err.message : String(err),
                ),
              );
            }
            return;
          }

          resOut.writeHead(404);
          resOut.end();
        });

        server.listen(port, () => {
          opts?.onAuthorizeUrl?.(`http://localhost:${port}/auth`);
        });

        const timer = setTimeout(() => {
          server.close();
          reject(new Error("Auth timed out"));
        }, timeout);
        server.on("close", () => clearTimeout(timer));
      });
    },
  };

  // ==========================================
  // Ref API
  // ==========================================

  const ref: AdkRefApi = {
    async add(
      entryInput: RefAddInput,
    ): Promise<{ security: SecuritySchemeSummary | null }> {
      let security: SecuritySchemeSummary | null = null;

      const config = await readConfig();
      const hasRegistries = (config.registries ?? []).length > 0;
      const name = entryInput.name ?? entryInput.ref;
      let entry: RefEntry = { ...entryInput, name };

      if ((config.refs ?? []).some((r) => refNameMatches(r, name))) {
        throw new AdkError({
          code: "REF_INVALID",
          message: `Cannot add ref "${entry.ref}" as "${name}": a ref with that name already exists`,
          hint: "Choose a different name, or remove/update the existing ref first.",
          details: { ref: entry.ref, name },
        });
      }

      // Auto-infer scheme from context
      if (!entry.scheme) {
        if (entry.sourceRegistry?.url) {
          entry = { ...entry, scheme: "registry" };
        } else if (entry.url) {
          entry = {
            ...entry,
            scheme: entry.url.startsWith("http") ? "https" : "mcp",
          };
        } else {
          throw new AdkError({
            code: "REF_INVALID",
            message:
              `Cannot add ref "${entry.ref}": could not determine connection type. ` +
              `Provide one of:\n` +
              `  - sourceRegistry: { url: <registry URL>, agentPath?: <agent path on that registry> }  (registry-backed ref)\n` +
              `  - url: "https://..."                                                                  (direct https/mcp ref)\n` +
              `For registry-backed refs, run \`registry list\` to find available registry URLs.`,
            hint:
              "CLI: pass --registry <name> or --url <url>. " +
              "Tool input: pass `sourceRegistry: { url, agentPath }` or `url: 'https://...'`.",
            details: { ref: entry.ref },
          });
        }
      }

      // Validate scheme-specific requirements
      if (entry.scheme === "registry" && !entry.sourceRegistry?.url) {
        throw new AdkError({
          code: "REF_INVALID",
          message:
            `Cannot add ref "${entry.ref}": scheme="registry" requires sourceRegistry.url. ` +
            `Required shape:\n` +
            `  {\n` +
            `    operation: "add",\n` +
            `    ref: "${entry.ref}",\n` +
            `    scheme: "registry",\n` +
            `    sourceRegistry: { url: <registry URL>, agentPath?: <agent path on that registry> }\n` +
            `  }\n` +
            `Run \`registry list\` to find the URL of a registered registry by name.`,
          hint:
            "CLI: adk ref add <ref> --registry <name>. " +
            "Tool input: pass sourceRegistry.url alongside agentPath (auto-resolution by registry name only happens when calling addRef() directly with a `registry` field, not via the @config tool).",
          details: {
            ref: entry.ref,
            scheme: entry.scheme,
            received: { sourceRegistry: entry.sourceRegistry },
            requiredShape: {
              sourceRegistry: { url: "<registry URL>", agentPath: "<optional agent path>" },
            },
          },
        });
      }

      if ((entry.scheme === "mcp" || entry.scheme === "https") && !entry.url) {
        throw new AdkError({
          code: "REF_INVALID",
          message:
            `Cannot add ref "${entry.ref}": scheme="${entry.scheme}" requires url. ` +
            `Required shape: { operation: "add", ref: "${entry.ref}", scheme: "${entry.scheme}", url: "https://..." }`,
          hint: "Provide the direct agent URL with `url: 'https://...'`.",
          details: {
            ref: entry.ref,
            scheme: entry.scheme,
            requiredShape: { url: "<agent URL>" },
          },
        });
      }

      let cacheEntry: RegistryCacheEntry | undefined;
      if (hasRegistries || entry.sourceRegistry?.url) {
        try {
          const consumer = await buildConsumerForRef(entry);
          const agentToInspect = entry.sourceRegistry?.agentPath ?? entry.ref;
          // Same multi-registry hazard as authStatus — target the ref's
          // own sourceRegistry so an unrelated registry can't shadow the
          // real lookup with an empty/error response.
          const info = await consumer.inspect(
            agentToInspect,
            entry.sourceRegistry?.url,
          );

          const requiresValidation = !!entry.sourceRegistry;
          if (requiresValidation) {
            const hasContent =
              info &&
              (info.description ||
                (info.tools && info.tools.length > 0) ||
                (info.toolSummaries && info.toolSummaries.length > 0));
            if (!hasContent) {
              // Inspect returned empty — fall back to browse to check if agent exists
              const registryUrl = entry.sourceRegistry?.url;
              let foundInBrowse = false;
              if (registryUrl) {
                try {
                  const agents = await consumer.browse(registryUrl);
                  const stripAt = (s: string) => s.replace(/^@/, "");
                  const refKey = stripAt(
                    entry.sourceRegistry?.agentPath ?? entry.ref,
                  );
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
                  details: {
                    ref: entry.ref,
                    sourceRegistry: entry.sourceRegistry,
                    scheme: entry.scheme,
                  },
                });
              }
            }
          }

          if (info?.security) security = info.security;
          const agentMode = (info as any)?.mode;
          if (agentMode) (entry as any).mode = agentMode;
          if (info?.upstream && !entry.url && agentMode !== "api") {
            entry.url = info.upstream as string;
            entry.scheme = entry.scheme ?? "mcp";
          }

          cacheEntry = buildCacheEntry(entry.ref, info);
        } catch (err) {
          if (err instanceof AdkError) throw err;
          throw new AdkError({
            code: "REGISTRY_UNREACHABLE",
            message: `Could not reach registry to validate "${entry.ref}"`,
            hint: "Check your registry connection with: adk registry test",
            details: {
              ref: entry.ref,
              error: err instanceof Error ? err.message : String(err),
            },
            cause: err,
          });
        }
      }

      const refs = [...(config.refs ?? []), entry];
      await writeConfig({ ...config, refs });
      await upsertRegistryCacheEntry(name, cacheEntry);

      return { security };
    },

    async remove(name: string): Promise<boolean> {
      const config = await readConfig();
      if (!config.refs?.length) return false;
      const before = config.refs.length;
      const refs = config.refs.filter((r) => !refNameMatches(r, name));
      if (refs.length === before) return false;
      await writeConfig({ ...config, refs });
      await removeRegistryCacheEntry(name);
      return true;
    },

    async list(): Promise<ResolvedRef[]> {
      const [config, cache] = await Promise.all([
        readConfig(),
        readRegistryCache(),
      ]);
      return (config.refs ?? [])
        .map(normalizeRef)
        .map((r) => hydrateFromCache(r, cache));
    },

    async get(name: string): Promise<ResolvedRef | null> {
      const [config, cache] = await Promise.all([
        readConfig(),
        readRegistryCache(),
      ]);
      const found = findRef(config.refs ?? [], name);
      if (!found) return null;
      return hydrateFromCache(found, cache);
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
        if (updates.name !== undefined) {
          const duplicate = config.refs?.some(
            (candidate) =>
              !refNameMatches(candidate, name) &&
              refNameMatches(candidate, updates.name as string),
          );
          if (duplicate) {
            throw new AdkError({
              code: "REF_INVALID",
              message: `Cannot rename ref "${name}" to "${updates.name}": a ref with that name already exists`,
              hint: "Choose a different name, or remove/update the existing ref first.",
              details: { name, newName: updates.name },
            });
          }
          updated.name = updates.name;
        }
        if (updates.scheme) updated.scheme = updates.scheme;
        if (updates.config)
          updated.config = { ...updated.config, ...updates.config };
        if (updates.sourceRegistry)
          updated.sourceRegistry = updates.sourceRegistry;
        return updated;
      });
      if (!found) return false;
      await writeConfig({ ...config, refs });
      return true;
    },

    async inspect(
      name: string,
      opts?: { full?: boolean },
    ): Promise<AgentInspection | null> {
      const config = await readConfig();
      const entry = findRef(config.refs ?? [], name);
      if (!entry) throw new Error(`Ref "${name}" not found`);

      const consumer = await buildConsumerForRef(entry);
      const result = await consumer.inspect(
        entry.sourceRegistry?.agentPath ?? entry.ref,
        entry.sourceRegistry?.url,
        opts,
      );

      // Side-effect: refresh the registry cache so subsequent ref.list()
      // / ref.get() calls see the latest description and tool summaries
      // without another network round-trip. Strips inputSchema (caller's
      // `result` is unaffected — it still carries the full data).
      await upsertRegistryCacheEntry(name, buildCacheEntry(entry.ref, result));

      return result;
    },

    async call(
      name: string,
      tool: string,
      params?: Record<string, unknown>,
    ): Promise<AdkRefCallResult> {
      const config = await readConfig();
      const entry = findRef(config.refs ?? [], name);
      if (!entry) throw new Error(`Ref "${name}" not found`);

      const accessToken =
        (await readRefSecret(name, "access_token")) ??
        (await readRefSecret(name, "api_key")) ??
        (await readRefSecret(name, "token"));

      // Resolve custom headers from config (e.g. { "X-API-Key": "secret:..." })
      const refConfig = (entry.config ?? {}) as Record<string, unknown>;
      const rawHeaders = refConfig.headers as
        | Record<string, string>
        | undefined;
      let resolvedHeaders: Record<string, string> | undefined;
      if (rawHeaders && typeof rawHeaders === "object") {
        resolvedHeaders = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (typeof v !== "string") continue;
          if (v.startsWith(SECRET_PREFIX)) {
            // Encrypted header value. Refuse to forward the ciphertext
            // verbatim — that historically leaked literal `secret:...`
            // strings as outbound HTTP headers, which upstreams rejected
            // with opaque 401s. Hard-fail with a clear message so the
            // misconfiguration surfaces instead of silently breaking auth.
            if (!options.encryptionKey) {
              throw new AdkError({
                code: "encryption_key_missing",
                message: `ref.call(${name}): header "${k}" is encrypted (secret:...) but this Adk instance was constructed without an encryptionKey, so the ciphertext cannot be resolved.`,
                hint: "Pass `encryptionKey` when constructing the Adk (createAdk/createAdkForUser/createAdkForTenant), or strip the encrypted header from the ref config.",
                details: { ref: name, header: k },
              });
            }
            try {
              resolvedHeaders[k] = await decryptSecret(
                v.slice(SECRET_PREFIX.length),
                options.encryptionKey,
              );
            } catch (err) {
              throw new AdkError({
                code: "encryption_key_mismatch",
                message: `ref.call(${name}): failed to decrypt header "${k}". The configured encryptionKey does not match the key used to encrypt this value.`,
                hint: "Re-encrypt the ref's headers with the current encryptionKey, or restore the previous key. Decrypting an unrelated value would have leaked ciphertext as a header before this fix.",
                details: { ref: name, header: k, cause: (err as Error)?.message },
              });
            }
          } else {
            resolvedHeaders[k] = v;
          }
        }
      }

      const doCall = async (token: string | null) => {
        // Direct MCP only for redirect/proxy agents with an MCP upstream.
        // API-mode agents must go through the registry (it does REST translation).
        const agentMode = (entry as any).mode ?? "redirect";
        if (token && entry.url && agentMode !== "api") {
          return callMcpDirect(
            entry.url,
            tool,
            params ?? {},
            token,
            resolvedHeaders,
          );
        }

        const consumer = await buildConsumerForRef(entry);
        const reg = resolveRegistryForRef(consumer, entry);

        return consumer.callRegistry(reg, {
          action: "execute_tool",
          path: entry.sourceRegistry?.agentPath ?? entry.ref,
          tool,
          ...("refCallMaxResultTokens" in options && {
            maxResultTokens: options.refCallMaxResultTokens,
          }),
          ...("refCallOverflow" in options && {
            overflow: options.refCallOverflow,
          }),
          params: {
            ...(params ?? {}),
            ...(token && { accessToken: token }),
            ...(resolvedHeaders && { _headers: resolvedHeaders }),
          },
        });
      };

      const result = await doCall(accessToken);

      // Check if the response indicates a 401 — try refreshing the token and retry once
      if (accessToken && isUnauthorized(result)) {
        const refreshed = await ref.refreshToken(name);
        if (refreshed) {
          return toAdkRefCallResult(await doCall(refreshed.accessToken));
        }
      }

      return toAdkRefCallResult(result);
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
      let inspectSucceeded = false;
      try {
        const consumer = await buildConsumerForRef(entry);
        // Pass `sourceRegistry.url` so inspect targets the registry the ref
        // came from. Without this, multi-registry consumers race every
        // configured registry and the first fulfilled response wins —
        // including {success:false} bodies from unrelated registries that
        // don't host this agent — which silently nulls out `security` and
        // makes `auth()` short-circuit to {type:"none", complete:true}.
        const info = await consumer.inspect(
          entry.sourceRegistry?.agentPath ?? entry.ref,
          entry.sourceRegistry?.url,
        );
        if (info) {
          inspectSucceeded = true;
          if (info.security) security = info.security;
        }
      } catch {
        // Can't reach registry
      }

      if (!security || security.type === "none") {
        // Persist an empty authFields map when the registry confirmed the
        // ref needs no auth — either an explicit `security.type === "none"`
        // or no `security` field on the agent at all. Host-side filters
        // that consult the registry-cache (e.g. atlas-os-sdk
        // `isRefConnected`) need this to distinguish "registry says this
        // ref needs no auth" from "we never warmed the cache". Without
        // it, auto-installed no-auth refs (e.g. web-search/Firecrawl)
        // look identical to never-inspected refs and get filtered out
        // of LLM-facing surfaces as "not connected" even though they
        // have nothing to connect.
        //
        // Gate on `inspectSucceeded` so we don't cache a false positive
        // when the registry was unreachable (network failure / consumer
        // error — `inspect` returned null/threw).
        if (inspectSucceeded) {
          await upsertRegistryCacheAuthFields(name, entry.ref, {});
        }
        return { name, security, complete: true, fields: {} };
      }

      const configKeys = Object.keys(entry.config ?? {});
      const tryResolveField = makeTryResolve({ name, entry, security });
      async function canResolve(
        field: string,
        oauthMetadata?: OAuthServerMetadata | null,
      ): Promise<boolean> {
        return (await tryResolveField(field, oauthMetadata)) !== null;
      }

      const fields: Record<string, CredentialField> = {};

      if (security.type === "oauth2") {
        const securityExt = security as {
          dynamicRegistration?: boolean;
          discoveryUrl?: string;
          flows?: Record<string, unknown>;
        };
        const hasRegistration = !!securityExt.dynamicRegistration;

        // `access_token.automated` decides whether `isRefAuthComplete`
        // requires the token to be present in `entry.config`. It should
        // be `true` ONLY when the SDK can mint the token with no user
        // action — i.e. a pure machine-to-machine flow like
        // `clientCredentials`. For `authorizationCode` / `implicit` /
        // `password` (and the "no flows declared" fallback), the user
        // must complete the OAuth consent step before the token lands
        // in config, so treat it as a normal user-supplied required
        // field. Without this, cached-authFields callers think the ref
        // is "connected" the moment `ref.add` runs, even though the
        // user never consented.
        const declaredFlows = securityExt.flows
          ? Object.keys(securityExt.flows)
          : [];
        const accessTokenAutomated =
          declaredFlows.length > 0 &&
          declaredFlows.every((f) => f === "clientCredentials");

        let oauthMetadata:
          | import("./mcp-client.js").OAuthServerMetadata
          | null = null;
        let needsSecret = false;
        if (securityExt.discoveryUrl) {
          oauthMetadata = await tryFetchOAuthMetadata(securityExt.discoveryUrl);
          if (oauthMetadata) {
            const authMethods =
              oauthMetadata.token_endpoint_auth_methods_supported ?? [];
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
          automated: accessTokenAutomated,
          present: configKeys.includes("access_token"),
          resolvable: false,
        };
      } else if (security.type === "apiKey") {
        const apiKeySec = security as {
          name?: string;
          headers?: Record<string, { description?: string }>;
        };
        const toStorageKey = (headerName: string) =>
          headerName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "");

        // config.headers: { "Header-Name": "value" } — check by header name (case-insensitive)
        const configHeaders = (
          entry?.config as Record<string, unknown> | undefined
        )?.headers as Record<string, unknown> | undefined;
        const configHeaderKeys = configHeaders
          ? Object.keys(configHeaders)
          : [];
        const hasConfigHeader = (name: string) =>
          configHeaderKeys.some((k) => k.toLowerCase() === name.toLowerCase());

        // Collect all declared header names from the security scheme
        const declaredHeaders: string[] = apiKeySec.headers
          ? Object.keys(apiKeySec.headers)
          : apiKeySec.name
            ? [apiKeySec.name]
            : [];

        for (const headerName of declaredHeaders) {
          const storageKey = toStorageKey(headerName);
          const inConfigHeaders = hasConfigHeader(headerName);
          const inLegacyKeys =
            configKeys.includes(storageKey) || configKeys.includes("api_key");
          fields[storageKey] = {
            required: true,
            automated: false,
            present: inConfigHeaders || inLegacyKeys,
            resolvable: await canResolve(storageKey),
          };
        }

        // Fallback: no headers declared at all → generic api_key field
        if (declaredHeaders.length === 0) {
          fields.api_key = {
            required: true,
            automated: false,
            present: !!configHeaders || configKeys.includes("api_key"),
            resolvable: await canResolve("api_key"),
          };
        }
      } else if (security.type === "http") {
        fields.token = {
          required: true,
          automated: false,
          present: configKeys.includes("token"),
          resolvable: await canResolve("token"),
        };
      } else if (security.type === "form") {
        // Form-based refs collect structured user input at connect time
        // (for example database host/user/password), then store the encoded
        // form payload in the canonical credential slot that `ref.call`
        // already reads and forwards to registry executors as
        // `params.accessToken`. Cache that derived credential requirement
        // instead of the individual form fields so host-side connected checks
        // answer the same question as the call path: "does this ref carry
        // the opaque credential blob needed to invoke it?"
        fields.access_token = {
          required: true,
          automated: false,
          present: configKeys.includes("access_token"),
          resolvable: await canResolve("access_token"),
        };
      }

      const complete = Object.values(fields).every(
        (f) => !f.required || f.present || f.resolvable,
      );

      // Persist the slim {required, automated} per-field shape into the
      // registry cache so `isRefAuthComplete` can answer subsequent
      // host-side "is this ref ready?" checks without re-fetching the
      // security scheme. We deliberately omit `present`/`resolvable`
      // because those are computed against the current entry.config and
      // host environment — caching them would go stale immediately.
      const authFields: Record<string, RegistryCacheAuthField> = {};
      for (const [field, info] of Object.entries(fields)) {
        authFields[field] = {
          required: info.required,
          automated: info.automated,
        };
      }
      await upsertRegistryCacheAuthFields(name, entry.ref, authFields);

      return { name, security, complete, fields };
    },

    async auth(
      name: string,
      opts?: {
        apiKey?: string;
        credentials?: Record<string, string>;
        /** Extra context to encode in the OAuth state (e.g., tenant/user IDs for multi-tenant callbacks) */
        stateContext?: Record<string, unknown>;
        /** Additional scopes to request (e.g., optional scopes declared by the agent) */
        scopes?: string[];
      },
    ): Promise<AuthStartResult> {
      const config = await readConfig();
      const entry = findRef(config.refs ?? [], name);
      if (!entry) throw new Error(`Ref "${name}" not found`);

      const status = await ref.authStatus(name);
      const security = status.security;
      const tryResolve = makeTryResolve({ name, entry, security });

      if (!security || security.type === "none") {
        return { type: "none", complete: true };
      }

      if (security.type === "apiKey") {
        const apiKeySec = security as {
          name?: string;
          prefix?: string;
          headers?: Record<string, { description?: string }>;
        };

        const toStorageKey = (headerName: string) =>
          headerName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "");

        // Check existing config.headers
        const existingHeaders = (
          (entry.config ?? {}) as Record<string, unknown>
        ).headers as Record<string, string> | undefined;

        // Collect declared headers: from security.headers or security.name
        const declaredHeaders: Array<{
          headerName: string;
          description?: string;
        }> = apiKeySec.headers
          ? Object.entries(apiKeySec.headers).map(([h, meta]) => ({
              headerName: h,
              description: meta.description,
            }))
          : apiKeySec.name
            ? [{ headerName: apiKeySec.name }]
            : [];

        if (declaredHeaders.length > 0) {
          const missingFields: AuthChallengeField[] = [];
          const resolvedHeaders: Record<string, string> = {};

          for (const { headerName, description } of declaredHeaders) {
            const storageKey = toStorageKey(headerName);
            // Check: credentials param → existing config.headers → legacy config key → resolve callback
            const value =
              opts?.credentials?.[storageKey] ??
              opts?.credentials?.[headerName] ??
              (existingHeaders &&
                Object.entries(existingHeaders).find(
                  ([k]) => k.toLowerCase() === headerName.toLowerCase(),
                )?.[1]) ??
              opts?.apiKey ??
              (await readRefSecret(name, storageKey)) ??
              (await tryResolve(storageKey));

            if (value) {
              resolvedHeaders[headerName] = value;
            } else {
              missingFields.push({
                name: storageKey,
                label: headerName,
                secret: true,
                description,
              });
            }
          }

          if (missingFields.length > 0) {
            return { type: "apiKey", complete: false, fields: missingFields };
          }

          // Store as config.headers for the ref.call path to forward
          const encKey = options.encryptionKey;
          const headersToStore: Record<string, string> = {};
          for (const [h, v] of Object.entries(resolvedHeaders)) {
            headersToStore[h] = encKey
              ? `${SECRET_PREFIX}${await encryptSecret(v, encKey)}`
              : v;
          }
          await ref.update(name, { config: { headers: headersToStore } });
          return { type: "apiKey", complete: true };
        }

        // Fallback: no headers declared → generic api_key
        const key =
          opts?.credentials?.["api_key"] ??
          opts?.apiKey ??
          (await tryResolve("api_key"));
        if (!key) {
          return {
            type: "apiKey",
            complete: false,
            fields: [
              {
                name: "api_key",
                label: "API Key",
                secret: true,
              },
            ],
          };
        }
        await storeRefSecret(name, "api_key", key);
        return { type: "apiKey", complete: true };
      }

      if (security.type === "http") {
        const httpSec = security as { scheme?: string };
        const isBasic = httpSec.scheme === "basic";

        if (isBasic) {
          const username =
            opts?.credentials?.["username"] ?? (await tryResolve("username"));
          const password =
            opts?.credentials?.["password"] ?? (await tryResolve("password"));
          if (!username || !password) {
            const missingFields: AuthChallengeField[] = [];
            if (!username)
              missingFields.push({
                name: "username",
                label: "Username",
                secret: false,
              });
            if (!password)
              missingFields.push({
                name: "password",
                label: "Password",
                secret: true,
              });
            return { type: "http", complete: false, fields: missingFields };
          }
          // Store as base64 encoded basic auth token
          const token = btoa(`${username}:${password}`);
          await storeRefSecret(name, "token", token);
          return { type: "http", complete: true };
        }

        // Bearer token
        const token =
          opts?.credentials?.["token"] ??
          opts?.apiKey ??
          (await tryResolve("token"));
        if (!token) {
          return {
            type: "http",
            complete: false,
            fields: [{ name: "token", label: "Bearer Token", secret: true }],
          };
        }
        await storeRefSecret(name, "token", token);
        return { type: "http", complete: true };
      }

      if (security.type === "oauth2") {
        const flows = (
          security as {
            flows?: {
              authorizationCode?: {
                authorizationUrl?: string;
                tokenUrl?: string;
              };
            };
          }
        ).flows;
        const authCodeFlow = flows?.authorizationCode;
        if (!authCodeFlow?.authorizationUrl) {
          return {
            type: "oauth2",
            complete: false,
            fields: [
              { name: "client_id", label: "Client ID", secret: false },
              { name: "client_secret", label: "Client Secret", secret: true },
            ],
          };
        }

        const authUrl = authCodeFlow.authorizationUrl;
        let metadata = await tryFetchOAuthMetadata(authUrl);
        if (!metadata) {
          const origin = new URL(authUrl).origin;
          metadata = await discoverOAuthMetadata(origin);
        }
        // Fallback: construct metadata from the security scheme's explicit URLs
        if (!metadata && authCodeFlow.tokenUrl) {
          const flowScopes = (authCodeFlow as Record<string, unknown>).scopes as
            | Record<string, string>
            | undefined;
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
        const fromHelper = await resolveOAuthClient({
          name,
          entry,
          security,
          metadata,
        });
        let clientId: string | undefined = fromHelper?.clientId;
        let clientSecret: string | undefined = fromHelper?.clientSecret;

        if (!clientId && metadata.registration_endpoint) {
          const supportedAuthMethods =
            metadata.token_endpoint_auth_methods_supported ?? ["none"];
          const preferredMethod = supportedAuthMethods.includes("none")
            ? "none"
            : (supportedAuthMethods[0] ?? "client_secret_post");

          const securityClientName = (security as { clientName?: string })
            .clientName;
          const reg = await dynamicClientRegistration(
            metadata.registration_endpoint,
            {
              clientName:
                securityClientName ?? options.oauthClientName ?? "adk",
              redirectUris: [redirectUri],
              grantTypes: ["authorization_code"],
              tokenEndpointAuthMethod: preferredMethod,
            },
          );
          clientId = reg.clientId;
          clientSecret = reg.clientSecret;
          await storeRefSecret(name, "client_id", clientId);
          if (clientSecret) {
            await storeRefSecret(name, "client_secret", clientSecret);
          }
        }

        if (!clientId) {
          // Return fields telling the caller what OAuth credentials to provide
          const missingFields: AuthChallengeField[] = [];
          if (!clientId) {
            missingFields.push({
              name: "client_id",
              label: "Client ID",
              secret: false,
            });
          }
          // Always ask for client_secret alongside client_id — most providers need it
          missingFields.push({
            name: "client_secret",
            label: "Client Secret",
            secret: true,
          });
          return { type: "oauth2", complete: false, fields: missingFields };
        }

        // State ties the callback back to this ref. Encode as base64 JSON
        // so callers can include extra context (tenant/user IDs).
        const statePayload = {
          ...opts?.stateContext,
          ref: entry.ref,
          name,
          ts: Date.now(),
        };
        const state = btoa(JSON.stringify(statePayload));

        const securityExt2 = security as {
          requiredScopes?: string[];
          optionalScopes?: string[];
          authorizationParams?: Record<string, string>;
        };
        const flowScopes = (authCodeFlow as Record<string, unknown>).scopes as
          | Record<string, string>
          | undefined;
        const agentScopes = [
          ...(securityExt2.requiredScopes ?? []),
          ...(flowScopes ? Object.keys(flowScopes) : []),
          ...(opts?.scopes ?? []),
        ].filter((v, i, a) => a.indexOf(v) === i);
        const scopes =
          agentScopes.length > 0
            ? [
                ...agentScopes,
                ...(metadata.scopes_supported?.includes("openid")
                  ? ["openid"]
                  : []),
              ]
            : metadata.scopes_supported;

        // Read provider-specific authorization params from the agent's security section
        // (e.g., { access_type: 'offline', prompt: 'consent' } for Google)
        const authorizationParams = securityExt2.authorizationParams;

        const { url: authorizeUrl, codeVerifier } =
          await buildOAuthAuthorizeUrl({
            authorizationEndpoint: metadata.authorization_endpoint,
            clientId,
            redirectUri,
            scopes,
            state,
            extraParams: authorizationParams,
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

    async authLocal(
      name: string,
      opts?: {
        onAuthorizeUrl?: (url: string) => void;
        timeoutMs?: number;
      },
    ): Promise<{ complete: boolean }> {
      const result = await ref.auth(name);
      if (result.complete) return { complete: true };

      const port = options.oauthCallbackPort ?? 8919;
      const timeout = opts?.timeoutMs ?? 300_000;
      const { createServer } = await import("node:http");

      // API key / HTTP auth — local credential form.
      if (
        result.fields &&
        result.fields.length > 0 &&
        result.type !== "oauth2"
      ) {
        return new Promise<{ complete: boolean }>((resolve, reject) => {
          const server = createServer(async (req, res) => {
            const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);

            if (req.method === "GET" && reqUrl.pathname === "/auth") {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(renderCredentialForm(name, result.fields!));
              return;
            }

            if (req.method === "POST" && reqUrl.pathname === "/auth") {
              const chunks: Buffer[] = [];
              for await (const chunk of req) chunks.push(chunk as Buffer);
              const body = Buffer.concat(chunks).toString();
              const params = new URLSearchParams(body);

              const credentials: Record<string, string> = {};
              for (const field of result.fields!) {
                const val = params.get(field.name);
                if (val) credentials[field.name] = val;
              }

              try {
                const authResult = await ref.auth(name, { credentials });
                if (authResult.complete) {
                  res.writeHead(200, { "Content-Type": "text/html" });
                  res.end(renderAuthSuccess(name));
                  server.close();
                  resolve({ complete: true });
                } else {
                  res.writeHead(200, { "Content-Type": "text/html" });
                  res.end(
                    renderCredentialForm(
                      name,
                      authResult.fields ?? result.fields!,
                      "Some credentials were missing or invalid.",
                    ),
                  );
                }
              } catch (err) {
                res.writeHead(500, { "Content-Type": "text/html" });
                res.end(
                  renderCredentialForm(
                    name,
                    result.fields!,
                    err instanceof Error ? err.message : String(err),
                  ),
                );
              }
              return;
            }

            res.writeHead(404);
            res.end();
          });

          server.listen(port, () => {
            if (opts?.onAuthorizeUrl) {
              opts.onAuthorizeUrl(`http://localhost:${port}/auth`);
            }
          });

          const timer = setTimeout(() => {
            server.close();
            reject(new Error("Auth timed out"));
          }, timeout);
          server.on("close", () => clearTimeout(timer));
        });
      }

      // OAuth2 — hand the authorize URL to the caller.
      if (result.type !== "oauth2" || !result.authorizeUrl) {
        throw new Error(`authLocal cannot handle auth type: ${result.type}`);
      }
      if (opts?.onAuthorizeUrl) {
        opts.onAuthorizeUrl(result.authorizeUrl);
      }

      // Spin up the callback server on oauthCallbackPort and block
      // until the OAuth provider redirects back.
      return new Promise<{ complete: boolean }>((resolve, reject) => {
        const server = createServer(async (req, res) => {
          const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
          if (reqUrl.pathname !== "/callback") return;

          const code = reqUrl.searchParams.get("code");
          const state = reqUrl.searchParams.get("state");

          if (!code || !state) {
            const error =
              reqUrl.searchParams.get("error") ?? "missing code/state";
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
            res.end(
              `<h1>Error</h1><p>${err instanceof Error ? err.message : String(err)}</p>`,
            );
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

    async refreshToken(name: string): Promise<{ accessToken: string } | null> {
      // Read stored refresh_token
      const refreshToken = await readRefSecret(name, "refresh_token");
      if (!refreshToken) return null;

      // Resolve token endpoint + OAuth client via the host's
      // `resolveCredentials` chain. Same chain `auth` uses (see
      // `resolveOAuthClient`) — kept symmetric so refresh works on every
      // ref `auth` works on, including first-party registry-hosted
      // clients whose creds live in env / tenant scope, not the user's
      // per-ref config.
      const entry = await ref.get(name);
      if (!entry) return null;

      const status = await ref.authStatus(name);
      const security = status.security;
      const flows =
        security && "flows" in security
          ? (
              security as {
                flows?: Record<
                  string,
                  { tokenUrl?: string; refreshUrl?: string }
                >;
              }
            ).flows
          : undefined;
      const authCodeFlow = flows?.authorizationCode;
      const tokenUrl = authCodeFlow?.refreshUrl ?? authCodeFlow?.tokenUrl;
      if (!tokenUrl) return null;

      const oauthClient = await resolveOAuthClient({ name, entry, security });
      if (!oauthClient) return null;
      const { clientId, clientSecret } = oauthClient;

      // POST to the token endpoint with grant_type=refresh_token
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      });
      if (clientSecret) {
        body.set("client_secret", clientSecret);
      }

      const res = await globalThis.fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!res.ok) return null;

      const data = (await res.json()) as Record<string, unknown>;
      const newAccessToken = data.access_token as string | undefined;
      if (!newAccessToken) return null;

      // Store the new tokens
      await storeRefSecret(name, "access_token", newAccessToken);
      if (data.refresh_token && typeof data.refresh_token === "string") {
        await storeRefSecret(name, "refresh_token", data.refresh_token);
      }

      return { accessToken: newAccessToken };
    },
  };

  // ==========================================
  // Top-level callback handler
  // ==========================================

  async function handleCallback(params: {
    code: string;
    state: string;
  }): Promise<{
    refName: string;
    complete: boolean;
    stateContext?: Record<string, unknown>;
  }> {
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
      await storeRefSecret(
        pending.refName,
        "refresh_token",
        tokens.refreshToken,
      );
    }

    let stateContext: Record<string, unknown> | undefined;
    try {
      stateContext = JSON.parse(atob(params.state));
    } catch {
      /* state wasn't base64 JSON — legacy format */
    }

    return { refName: pending.refName, complete: true, stateContext };
  }

  return { registry, ref, readConfig, writeConfig, handleCallback };
}
