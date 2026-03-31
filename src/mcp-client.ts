/**
 * MCP Client — Connect to remote MCP servers.
 *
 * Handles:
 * - MCP-over-HTTP transport (JSON-RPC)
 * - initialize handshake + tools/list + tools/call
 * - OAuth auth discovery (.well-known/oauth-authorization-server)
 * - Dynamic client registration (RFC 7591)
 * - PKCE OAuth flow (RFC 7636)
 * - Static auth (bearer token, headers)
 * - Automatic token refresh on 401
 *
 * Used by registry-consumer for `registry: 'mcp'` refs.
 */

import { generatePkcePair } from "./pkce.js";

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

/** MCP server capabilities from initialize response */
export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  /** Registry-specific capabilities (only on agent registries) */
  registry?: {
    version: string;
    features?: string[];
    oauthCallbackUrl?: string;
  };
}

/** MCP server info from initialize response */
export interface McpServerInfo {
  name: string;
  version: string;
}

/** MCP initialize result */
export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: McpServerInfo;
}

/** MCP tool definition from tools/list */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Auth configuration for MCP client */
export type McpClientAuth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "headers"; headers: Record<string, string> }
  | {
      type: "oauth";
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      tokenEndpoint: string;
      clientId: string;
      clientSecret?: string;
    };

/** Options for creating an MCP client */
export interface McpClientOptions {
  /** MCP server URL */
  url: string;
  /** Auth configuration */
  auth?: McpClientAuth;
  /** Custom fetch implementation */
  fetch?: typeof globalThis.fetch;
}

/** MCP client interface */
export interface McpClient {
  /** Server info from initialize */
  serverInfo: McpServerInfo;
  /** Server capabilities from initialize */
  capabilities: McpServerCapabilities;
  /** Whether this server is an agent registry (has registry capabilities) */
  isRegistry: boolean;
  /** List available tools */
  listTools(): Promise<McpToolDefinition[]>;
  /** Call a tool */
  callTool(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
  /** Disconnect / cleanup */
  close(): void;
}

// ============================================
// JSON-RPC Helpers
// ============================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let requestId = 0;

function makeRequest(
  method: string,
  params?: Record<string, unknown>,
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: ++requestId,
    method,
    ...(params && { params }),
  };
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
  return { url: url.toString(), codeVerifier: pkce.codeVerifier };
}

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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
// MCP Client
// ============================================

/**
 * Create an MCP client connected to a remote server.
 *
 * Performs the MCP initialize handshake and returns a client
 * that can list tools and call them.
 */
export async function createMcpClient(
  options: McpClientOptions,
): Promise<McpClient> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const serverUrl = options.url.replace(/\/$/, "");
  let auth = options.auth ?? { type: "none" as const };

  /** Build headers for authenticated requests */
  function getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    switch (auth.type) {
      case "bearer":
        headers.Authorization = `Bearer ${auth.token}`;
        break;
      case "oauth":
        headers.Authorization = `Bearer ${auth.accessToken}`;
        break;
      case "headers":
        Object.assign(headers, auth.headers);
        break;
    }
    return headers;
  }

  /** Make an MCP JSON-RPC call */
  async function rpc(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const request = makeRequest(method, params);
    const res = await fetchFn(serverUrl, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(request),
    });

    // Auto-refresh on 401 for OAuth
    if (res.status === 401 && auth.type === "oauth" && auth.refreshToken) {
      const refreshed = await refreshAccessToken(auth.tokenEndpoint, {
        refreshToken: auth.refreshToken,
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
      });
      auth = {
        ...auth,
        accessToken: refreshed.accessToken,
        ...(refreshed.refreshToken && {
          refreshToken: refreshed.refreshToken,
        }),
        ...(refreshed.expiresIn && {
          expiresAt: Date.now() + refreshed.expiresIn * 1000,
        }),
      };
      // Retry with new token
      const retryRes = await fetchFn(serverUrl, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(request),
      });
      if (!retryRes.ok) {
        throw new Error(
          `MCP call failed after token refresh: ${retryRes.status}`,
        );
      }
      const retryJson = (await retryRes.json()) as JsonRpcResponse;
      if (retryJson.error) {
        throw new Error(
          `MCP RPC error: ${retryJson.error.message}`,
        );
      }
      return retryJson.result;
    }

    if (!res.ok) {
      throw new Error(`MCP call failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as JsonRpcResponse;
    if (json.error) {
      throw new Error(`MCP RPC error: ${json.error.message}`);
    }
    return json.result;
  }

  // Initialize handshake
  const initResult = (await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "agents-sdk-client", version: "1.0.0" },
  })) as McpInitializeResult;

  // Send initialized notification
  await rpc("notifications/initialized");

  const client: McpClient = {
    serverInfo: initResult.serverInfo,
    capabilities: initResult.capabilities,
    isRegistry: !!initResult.capabilities.registry,

    async listTools(): Promise<McpToolDefinition[]> {
      const result = (await rpc("tools/list")) as {
        tools: McpToolDefinition[];
      };
      return result.tools ?? [];
    },

    async callTool(
      name: string,
      params: Record<string, unknown> = {},
    ): Promise<unknown> {
      const result = (await rpc("tools/call", {
        name,
        arguments: params,
      })) as { content?: unknown[] };
      // Extract text content if available
      if (result.content && Array.isArray(result.content)) {
        const textItem = result.content.find(
          (c: unknown) =>
            typeof c === "object" &&
            c !== null &&
            "type" in c &&
            (c as Record<string, unknown>).type === "text",
        ) as { text?: string } | undefined;
        if (textItem?.text) {
          try {
            return JSON.parse(textItem.text);
          } catch {
            return textItem.text;
          }
        }
      }
      return result;
    },

    close() {
      // No persistent connection to clean up for HTTP transport
    },
  };

  return client;
}
