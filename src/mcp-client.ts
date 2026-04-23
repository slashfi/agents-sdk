/**
 * MCP Client Auth — OAuth utilities for connecting to MCP servers.
 *
 * Standalone utilities for:
 * - OAuth Authorization Server discovery (.well-known/oauth-authorization-server, RFC 8414)
 * - Dynamic client registration (RFC 7591)
 * - PKCE OAuth authorization URL construction
 * - Authorization code → token exchange (with PKCE)
 * - Token refresh
 *
 * These are used by registry-consumer.ts when connecting to MCP servers
 * or registries that require OAuth. The MCP transport itself is handled
 * by registry-consumer — this module only provides auth primitives.
 */

import { generatePkcePair } from "./pkce.js";
import type { RegistryAuthRequirement } from "./define-config.js";
import type { FetchFn } from "./fetch-types.js";

// ============================================
// Types
// ============================================

/** OAuth Authorization Server Metadata (RFC 8414) */
export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

// ============================================
// OAuth Discovery
// ============================================

/**
 * Discover OAuth authorization server metadata.
 * Probes .well-known/oauth-authorization-server (RFC 8414).
 * Returns null if the server doesn't support OAuth.
 */
export async function discoverOAuthMetadata(
  serverUrl: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<OAuthServerMetadata | null> {
  const url = `${serverUrl.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    return (await res.json()) as OAuthServerMetadata;
  } catch {
    return null;
  }
}

// ============================================
// Dynamic Client Registration
// ============================================

/**
 * Dynamically register a client with an OAuth server.
 * RFC 7591 — used when the MCP server supports dynamic registration.
 */
export async function dynamicClientRegistration(
  registrationEndpoint: string,
  params: {
    clientName: string;
    redirectUris?: string[];
    grantTypes?: string[];
    tokenEndpointAuthMethod?: string;
  },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await fetchFn(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: params.clientName,
      redirect_uris: params.redirectUris,
      grant_types: params.grantTypes ?? ["authorization_code"],
      token_endpoint_auth_method:
        params.tokenEndpointAuthMethod ?? "none",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    throw new Error(
      `Dynamic client registration failed: ${res.status} ${text}`,
    );
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    clientId: data.client_id as string,
    clientSecret: data.client_secret as string | undefined,
  };
}

// ============================================
// Authorization URL
// ============================================

/**
 * Build an OAuth authorization URL with PKCE.
 * Returns the URL + the code_verifier (to be stored server-side).
 */
export async function buildOAuthAuthorizeUrl(params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  state?: string;
  /**
   * Extra query parameters appended to the authorization URL.
   * Used for provider-specific params not covered by the OIDC spec.
   * @example { access_type: 'offline', prompt: 'consent' } // Google
   */
  extraParams?: Record<string, string>;
}): Promise<{
  url: string;
  codeVerifier: string;
}> {
  const pkce = await generatePkcePair();
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code_challenge", pkce.codeChallenge);
  url.searchParams.set("code_challenge_method", pkce.codeChallengeMethod);
  if (params.scopes?.length) {
    url.searchParams.set("scope", params.scopes.join(" "));
  }
  if (params.state) {
    url.searchParams.set("state", params.state);
  }
  if (params.extraParams) {
    for (const [k, v] of Object.entries(params.extraParams)) {
      url.searchParams.set(k, v);
    }
  }
  return { url: url.toString(), codeVerifier: pkce.codeVerifier };
}

// ============================================
// Token Exchange
// ============================================

/**
 * Exchange an authorization code for tokens (with PKCE).
 */
export async function exchangeCodeForTokens(
  tokenEndpoint: string,
  params: {
    code: string;
    codeVerifier: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
  },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
}> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.codeVerifier,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
  });
  if (params.clientSecret) {
    body.set("client_secret", params.clientSecret);
  }

  const res = await fetchFn(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string | undefined,
    expiresIn: data.expires_in as number | undefined,
    tokenType: data.token_type as string | undefined,
  };
}

// ============================================
// Token Refresh
// ============================================

/**
 * Refresh an access token.
 */
export async function refreshAccessToken(
  tokenEndpoint: string,
  params: {
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
  },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });
  if (params.clientSecret) {
    body.set("client_secret", params.clientSecret);
  }

  const res = await fetchFn(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string | undefined,
    expiresIn: data.expires_in as number | undefined,
  };
}

// ============================================
// Registry Auth Probe (RFC 6750 + RFC 9728)
// ============================================

/**
 * Parse a `WWW-Authenticate` header of the form
 *   `Bearer realm="x", resource_metadata="https://..."`
 * Returns the scheme and any `key="value"` params. Tolerant of
 * single-value headers and missing params.
 */
export function parseWwwAuthenticate(
  header: string,
): { scheme: string; params: Record<string, string> } {
  const spaceIdx = header.indexOf(" ");
  const scheme = (spaceIdx === -1 ? header : header.slice(0, spaceIdx)).trim();
  const rest = spaceIdx === -1 ? "" : header.slice(spaceIdx + 1);
  const params: Record<string, string> = {};
  for (const match of rest.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g)) {
    params[match[1]!.toLowerCase()] = match[2]!;
  }
  return { scheme, params };
}

/** RFC 9728 protected-resource metadata. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  bearer_methods_supported?: string[];
  scopes_supported?: string[];
  resource_documentation?: string;
}

/** Fetch RFC 9728 metadata. Returns null on any failure. */
export async function discoverProtectedResourceMetadata(
  metadataUrl: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<ProtectedResourceMetadata | null> {
  try {
    const res = await fetchFn(metadataUrl);
    if (!res.ok) return null;
    return (await res.json()) as ProtectedResourceMetadata;
  } catch {
    return null;
  }
}

/**
 * Probe an MCP URL to see whether it requires authentication.
 *
 * Sends a minimal `initialize` request. On 200 the server accepts anonymous
 * connections; on 401 we parse the `WWW-Authenticate` header and, if it
 * points at RFC 9728 resource metadata, fetch it so the caller can record
 * the authorization servers and scopes.
 *
 * Returns `{ ok: true }` when no auth is required, or
 * `{ ok: false, requirement }` when the server challenged the request.
 * Other failures (DNS, TLS, unexpected status) surface as `{ ok: null }`
 * — the caller should treat those as probe-inconclusive rather than
 * asserting auth is required.
 */
export async function probeRegistryAuth(
  registryUrl: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<
  | { ok: true }
  | { ok: false; requirement: RegistryAuthRequirement }
  | { ok: null }
> {
  const url = registryUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "agents-sdk-probe", version: "1.0.0" },
        },
      }),
    });
  } catch {
    return { ok: null };
  }

  if (res.status !== 401) {
    return res.ok ? { ok: true } : { ok: null };
  }

  const wwwAuth = res.headers.get("www-authenticate") ?? "";
  const { scheme, params } = parseWwwAuthenticate(wwwAuth);
  const requirement: RegistryAuthRequirement = {};
  if (scheme) requirement.scheme = scheme;
  if (params.realm) requirement.realm = params.realm;

  const metadataUrl = params.resource_metadata;
  if (metadataUrl) {
    requirement.resourceMetadataUrl = metadataUrl;
    const metadata = await discoverProtectedResourceMetadata(metadataUrl, fetchFn);
    if (metadata) {
      if (metadata.authorization_servers?.length) {
        requirement.authorizationServers = metadata.authorization_servers;
      }
      if (metadata.scopes_supported?.length) {
        requirement.scopes = metadata.scopes_supported;
      }
      if (metadata.bearer_methods_supported?.length) {
        requirement.bearerMethodsSupported = metadata.bearer_methods_supported;
      }
    }
  }

  return { ok: false, requirement };
}
