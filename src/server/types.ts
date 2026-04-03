/**
 * Server type definitions.
 */

import type { AuthStore } from "../agent-definitions/auth.js";
import type { SecretStore } from "../agent-definitions/secrets.js";
import type { SigningKey } from "../jwt.js";
import type { OIDCProviderConfig } from "../oidc-signin.js";
import type { AgentRegistry } from "../registry.js";

// ── Server Types ──
export interface TrustedIssuer {
  /** JWKS endpoint base URL (appends /.well-known/jwks.json) */
  issuer: string;
  /** Scopes granted to tokens from this issuer */
  scopes: string[];
}

/** OAuth identity provider for /oauth/authorize + /oauth/callback flows */
export interface OAuthIdentityProvider {
  /**
   * Handle /oauth/authorize — redirect the user to an external IdP.
   * Return a Response (typically a 302 redirect).
   */
  authorize(
    req: Request,
    params: {
      /** The verified JWT from the foreign registry */
      token: string;
      /** Claims from the verified JWT */
      claims: Record<string, unknown>;
      /** Where to redirect after completion */
      redirectUri: string;
      /** Base URL of this server */
      baseUrl: string;
      /** OAuth scope (e.g. "setup" for tenant creation flow) */
      scope?: string;
    },
  ): Promise<Response>;

  /**
   * Handle /oauth/callback — process the IdP response.
   * Should link the foreign identity to a local user and redirect back.
   * Return a Response (typically a 302 redirect to redirectUri).
   */
  callback(
    req: Request,
    params: {
      /** Base URL of this server */
      baseUrl: string;
    },
  ): Promise<Response>;
}
export interface AgentServerOptions {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Hostname to bind to (default: 'localhost') */
  hostname?: string;
  /** Base path for endpoints (default: '') */
  basePath?: string;
  /** Enable CORS (default: true) */
  cors?: boolean;
  /** Server name reported in MCP initialize (default: 'agents-sdk') */
  serverName?: string;
  /** Server version reported in MCP initialize (default: '1.0.0') */
  serverVersion?: string;
  /** Secret store for handling secret: refs in tool params */
  secretStore?: SecretStore;
  /** Trusted JWT issuers with per-issuer scopes */
  trustedIssuers?: (TrustedIssuer | string)[];
  /** Pre-generated signing key (if not provided, one is generated on start) */
  signingKey?: SigningKey;
  /** OAuth identity provider for cross-registry user linking */
  oauthIdentityProvider?: OAuthIdentityProvider;
  /** Key store for managed key rotation (if provided, uses createKeyManager instead of simple key gen) */
  keyStore?: import("../key-manager.js").KeyStore;
  /** OIDC provider for user sign-in (authorization code flow) */
  oidcProvider?: OIDCProviderConfig;
  /**
   * Custom auth resolver — called before the built-in JWT/header auth.
   * Return a ResolvedAuth to authenticate the request, or null to fall
   * through to the default auth chain.
   *
   * Use this when the server is mounted behind a proxy or middleware
   * that handles its own auth (e.g., API key validation).
   *
   * @example
   * ```typescript
   * createAgentServer(registry, {
   *   resolveAuth: async (req) => {
   *     const apiKey = req.headers.get('x-api-key');
   *     if (apiKey === process.env.API_KEY) {
   *       return { callerId: 'api-client', callerType: 'system', scopes: ['*'], claims: {} };
   *     }
   *     return null;
   *   },
   * });
   * ```
   */
  resolveAuth?: (req: Request) => Promise<ResolvedAuth | null>;
  /**
   * Registry capabilities — advertised in MCP initialize response.
   * When set, this server identifies as an agent registry (superset of MCP).
   * Consumers use this to differentiate `registry` type from plain `mcp`.
   */
  registry?: {
    /** Registry protocol version */
    version?: string;
    /** Feature flags (e.g., 'shared-oauth', 'agent-listing') */
    features?: string[];
    /** OAuth callback URL for shared OAuth flows */
    oauthCallbackUrl?: string;
  };
}

export interface AgentServer {
  /** Initialize signing keys without starting HTTP server */
  initKeys(): Promise<void>;
  /** Start the server */
  start(): Promise<void>;
  /** Stop the server */
  stop(): Promise<void>;
  /** Handle a request (for custom integrations / framework composition) */
  fetch(req: Request): Promise<Response>;
  /** Get the server URL (only available after start) */
  url: string | null;
  /** The agent registry this server uses */
  registry: AgentRegistry;
  /** Sign a JWT with the server's signing key (for outbound calls) */
  signJwt(claims: Record<string, unknown>): Promise<string>;
  /** Resolve auth from a request using this server's auth config + signing keys */
  resolveAuth(req: Request): Promise<ResolvedAuth | null>;
  /** Dynamically add a trusted JWT issuer at runtime */
  addTrustedIssuer(issuerUrl: string, scopes?: string[]): void;
}

// ── JSON-RPC Types ──
export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Auth Types ──
export interface AuthConfig {
  store?: AuthStore;
  /** @deprecated Use JWT scopes instead. Will be removed in a future version. */
  tokenTtl?: number;
}

export interface ResolvedAuth {
  issuer?: string;
  callerId: string;
  callerType: "agent" | "user" | "system";
  scopes: string[];
  /** All JWT claims from the verified token (passthrough) */
  claims: Record<string, unknown>;
}

/** Check if auth has admin-level access (wildcard or admin scope) */
export function hasAdminScope(auth: ResolvedAuth | null): boolean {
  if (!auth) return false;
  return auth.scopes.includes("*") || auth.scopes.includes("admin");
}

// ── Hono Env ──
export type HonoEnv = {
  Variables: {
    auth: ResolvedAuth | null;
  };
};

// ── Shared server context (passed to route handlers) ──
export interface ServerContext {
  registry: AgentRegistry;
  options: AgentServerOptions;
  serverSigningKeys: SigningKey[];
  resolveBaseUrl: (req: Request) => string;
  resolveAuthFn: (req: Request) => Promise<ResolvedAuth | null>;
  authConfig: AuthConfig;
  secretStore?: SecretStore;
}
