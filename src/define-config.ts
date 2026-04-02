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

/** A registry endpoint the consumer connects to */
export interface RegistryEntry {
  /** Registry URL (e.g., 'https://registry.slash.com') */
  url: string;

  /** How to authenticate with this registry */
  auth?: RegistryAuth;

  /** Human-readable name / alias for this registry */
  name?: string;

  /** Publisher name shown in the app store UI */
  publisher?: string;
}

// ============================================
// Ref Config
// ============================================

/** Inline config for a ref — values can be literals or secret URLs */
export type RefConfig = Record<string, string | number | boolean>;

/** A ref entry — describes how to connect to an agent */
export type RefEntry = {
      /** Agent definition path (resolved from registries) */
      ref: string;

      /** Connection scheme */
      scheme?: 'mcp' | 'https' | 'registry';

      /** Direct URL to the agent (e.g. https://mcp.notion.com/mcp) */
      url?: string;

      /** Headers to inject on every request (values support {{secret-uri}} templates) */
      headers?: Record<string, string>;

      /** Local alias for this instance (required for multi-instance) */
      as?: string;

      /** Per-instance config (secrets as URIs, literals as values) */
      config?: RefConfig;

      /** The registry where this ref was discovered */
      sourceRegistry?: { url: string; agentPath: string };
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

/** Normalize a ref entry to its full form */
export function normalizeRef(entry: RefEntry): ResolvedRef {
  return {
    ...entry,
    name: entry.as ?? entry.ref,
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
