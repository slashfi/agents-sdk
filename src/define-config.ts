/**
 * defineConfig — Declarative configuration for agent consumers.
 *
 * A consumer's config declares which registries to connect to and which
 * agent refs to use. This is the "package.json" of the agent world:
 * registries are like npm registries, refs are like dependencies.
 *
 * @example
 * ```typescript
 * import { defineConfig } from '@slashfi/agents-sdk';
 *
 * export default defineConfig({
 *   registries: [
 *     { url: 'https://registry.slash.com' },
 *     { url: 'https://twin.slash.com/tenants/slash', auth: { type: 'bearer' } },
 *   ],
 *   refs: [
 *     'notion',
 *     { ref: 'postgres', as: 'prod-db', config: { url: 'https://twin.slash.com/secrets/crdb-url' } },
 *     { ref: 'postgres', as: 'staging', config: { url: 'https://twin.slash.com/secrets/staging-url' } },
 *   ],
 * });
 * ```
 */

// ============================================
// Registry Config
// ============================================

/** Authentication methods for connecting to a registry */
export type RegistryAuth =
  | { type: "none" }
  | { type: "bearer"; token?: string; tokenUrl?: string }
  | { type: "api-key"; key?: string; header?: string }
  | { type: "jwt"; issuer?: string };

/**
 * Proxy configuration for a registry.
 *
 * When set, ref operations (`auth`, `auth-status`, `call`, `inspect`,
 * `resources`, `read`, `refresh-token`) for refs sourced from this
 * registry are forwarded to a server-side agent that implements the
 * adk-tools surface. Use this for cloud-hosted registries that own
 * OAuth client credentials and/or user tokens on behalf of consumers
 * (e.g. `api.twin.slash.com/mcp`).
 *
 * - `mode: 'required'` — all ref ops MUST route through the proxy agent.
 *   Local handshake (`ref.authLocal`) is refused for refs from this
 *   registry because the local environment has no way to build an
 *   authorize URL without the server's client credentials.
 * - `mode: 'optional'` — proxy is the default; callers may opt out via
 *   `{ preferLocal: true }` on a per-op basis when they already hold
 *   local credentials.
 */
export interface RegistryProxy {
  mode: 'required' | 'optional';
  /** Agent path to forward to. Defaults to `@config`. */
  agent?: string;
}

/**
 * OAuth state captured after `adk registry auth` completes a dynamic-client
 * registration + authorization-code flow against a registry. Stored alongside
 * `auth.token` so the access token can be refreshed without re-prompting the
 * user. The `auth.token` slot holds the current access token; everything
 * needed to refresh it lives here.
 */
export interface RegistryOAuthState {
  /** Token endpoint used for code exchange / refresh. */
  tokenEndpoint: string;
  /** Client ID issued by dynamic client registration (RFC 7591). */
  clientId: string;
  /** Client secret from dynamic registration, when the server issued one. */
  clientSecret?: string;
  /** Refresh token returned by the token endpoint, if any. */
  refreshToken?: string;
  /** Absolute expiry (ISO 8601) derived from `expires_in` at exchange time. */
  expiresAt?: string;
  /** Scopes the access token was granted for. */
  scopes?: string[];
}

/**
 * Captured auth challenge from a registry that rejected an unauthenticated
 * probe (RFC 6750 `WWW-Authenticate` + RFC 9728 protected-resource metadata).
 * When present on a `RegistryEntry`, the registry has been seen to require
 * credentials and ref ops will fail until `adk registry auth` is run.
 */
export interface RegistryAuthRequirement {
  /** Auth scheme advertised in `WWW-Authenticate` (e.g. `Bearer`). */
  scheme?: string;
  /** Realm advertised in `WWW-Authenticate`. */
  realm?: string;
  /** RFC 9728 `resource_metadata` URL parsed from the challenge. */
  resourceMetadataUrl?: string;
  /** Authorization servers from the protected-resource metadata. */
  authorizationServers?: string[];
  /** Scopes supported by the resource. */
  scopes?: string[];
  /** Bearer-methods advertised by the resource (`header`, `body`, `query`). */
  bearerMethodsSupported?: string[];
}

/** A registry endpoint the consumer connects to */
export interface RegistryEntry {
  /** Registry URL (e.g., 'https://registry.slash.com') */
  url: string;

  /** How to authenticate with this registry */
  auth?: RegistryAuth;

  /** Arbitrary headers to send with every request to this registry (values can be secret URIs) */
  headers?: Record<string, string>;

  /** Human-readable name / alias for this registry */
  name?: string;

  /** Publisher name shown in the app store UI */
  publisher?: string;

  /** Connection status — set by validation/test, used to filter active entries */
  status?: 'active' | 'inactive' | 'error';

  /**
   * If set, ref ops for refs sourced from this registry are forwarded
   * to a server-side adk-tools agent (default `@config`) instead of
   * running locally. See {@link RegistryProxy}.
   */
  proxy?: RegistryProxy;

  /**
   * Populated by `adk registry add` when the probe returned 401. Cleared
   * by `adk registry auth`. Registry ops refuse to run while this is set
   * and no usable auth credentials are configured.
   */
  authRequirement?: RegistryAuthRequirement;

  /**
   * OAuth lifecycle state — refresh token, client credentials from dynamic
   * registration, token endpoint, expiry. Populated by `adk registry auth`
   * when the flow went through OAuth; absent for manually-supplied bearer
   * tokens.
   */
  oauth?: RegistryOAuthState;
}

// ============================================
// Ref Config
// ============================================

/** Inline config for a ref — any JSON-serializable object */
export type RefConfig = Record<string, unknown>;

/** A ref entry — describes how to connect to an agent */
export type RefEntry = {
      /** Canonical agent path on the remote registry (e.g. `notion`, `linear`). */
      ref: string;

      /**
       * Local identifier for this ref. Used by all operations
       * (call/remove/auth/update/…) to look up the entry. If omitted,
       * the canonical `ref` string is used as the identifier — the
       * common case "one local instance per agent" requires only
       * `{ ref: 'notion', ... }`. Set `name` to a different value only
       * when you need multiple local instances of the same remote
       * agent (e.g. `{ ref: 'notion', name: 'work-notion' }`).
       */
      name?: string;

      /** Connection scheme */
      scheme?: 'mcp' | 'https' | 'registry';

      /** Direct URL to the agent (e.g. https://mcp.notion.com/mcp) */
      url?: string;

      /**
       * @deprecated Use `name` instead. `as` is preserved for reading
       * old consumer-config.json files; new writes emit `name`.
       */
      as?: string;

      /** Per-instance config (headers, secrets, etc. — values support {{secret-uri}} templates) */
      config?: RefConfig;

      /** The registry where this ref was discovered */
      sourceRegistry?: { url: string; agentPath: string };

      /** Connection status — set by validation/test, used to filter active entries */
      status?: 'active' | 'inactive' | 'error';
    };

// ============================================
// Consumer Config
// ============================================

/** The full consumer configuration */
export interface ConsumerConfig {
  /** Registries to connect to, in resolution order */
  registries?: (string | RegistryEntry)[];

  /** Agent refs to use — your "dependencies" */
  refs?: RefEntry[];

  /** Optional metadata */
  meta?: {
    /** Config owner (user ID, tenant ID, etc.) */
    owner?: string;
    /** Human-readable description */
    description?: string;
    [key: string]: unknown;
  };
}

// ============================================
// Resolved Config (indexed output)
// ============================================

/** A normalized registry entry (after resolution) */
export interface ResolvedRegistry {
  url: string;
  name: string;
  publisher: string;
  auth: RegistryAuth;
  /** Resolved headers (secret URIs replaced with values at resolution time) */
  headers?: Record<string, string>;
}

/** A normalized ref entry (after resolution) */
/** A resolved ref — RefEntry with computed fields filled in */
export type ResolvedRef = RefEntry & {
  /** Local name (alias or ref name) */
  name: string;
  /** Resolved config (always present) */
  config: RefConfig;
};

/** The serialized/indexed output stored in VCS */
export interface ResolvedConfig {
  /** Timestamp of resolution */
  resolvedAt: string;

  /** Source config hash (for cache invalidation) */
  sourceHash: string;

  /** Normalized registries */
  registries: ResolvedRegistry[];

  /** Normalized refs */
  refs: ResolvedRef[];

  /** Metadata */
  meta?: ConsumerConfig["meta"];
}

// ============================================
// Helpers
// ============================================

/**
 * Normalize a ref entry to its full form.
 *
 * Local identifier resolution order: `entry.name` → `entry.as` (legacy)
 * → `entry.ref` (canonical). This order makes the tool/API surface
 * consistent with the `ref.add({ ref, name })` contract while still
 * reading old `{ ref, as }` entries from pre-0.74 consumer-config.json.
 */
export function normalizeRef(entry: RefEntry): ResolvedRef {
  return {
    ...entry,
    name: entry.name ?? entry.as ?? entry.ref,
    config: entry.config ?? {},
  };
}

/** Normalize a registry entry to its full form */
export function normalizeRegistry(
  entry: string | RegistryEntry,
): ResolvedRegistry {
  if (typeof entry === "string") {
    const url = new URL(entry);
    return {
      url: entry,
      name: url.hostname,
      publisher: url.hostname.split(".")[0],
      auth: { type: "none" },
    };
  }
  const url = new URL(entry.url);
  return {
    url: entry.url,
    name: entry.name ?? url.hostname,
    publisher: entry.publisher ?? url.hostname.split(".")[0],
    auth: entry.auth ?? { type: "none" },
    ...(entry.headers && { headers: entry.headers }),
  };
}

/** Supported secret URI schemes */
const SECRET_SCHEMES = ["file:", "https:", "http:", "env:"];

/** Check if a value is a secret URI (file://, https://, env://) */
export function isSecretUri(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return SECRET_SCHEMES.includes(url.protocol);
  } catch {
    return false;
  }
}

/** @deprecated Use isSecretUri instead */
export const isSecretUrl = isSecretUri;
