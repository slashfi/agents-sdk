/**
 * Integrations Agent (@integrations)
 *
 * Built-in agent for managing third-party API integrations.
 * Provides OAuth2 flows, provider config management, and API calling.
 *
 * Features:
 * - Provider config management (setup/list/get)
 * - OAuth2 authorization code flow (connect)
 * - API calling with auto-injected auth (REST + GraphQL)
 * - Agent-registry type for agent-to-agent federation
 * - Pluggable IntegrationStore interface
 *
 * @example
 * ```typescript
 * import { createAgentRegistry, createIntegrationsAgent } from '@slashfi/agents-sdk';
 *
 * const registry = createAgentRegistry();
 * registry.register(createIntegrationsAgent({
 *   store: myIntegrationStore,
 *   callbackBaseUrl: 'https://myapp.com/integrations/callback',
 * }));
 * ```
 */

import { defineAgent, defineTool } from "../define.js";
import { pendingCollections, generateCollectionToken } from "../server.js";
import type { AgentDefinition, ToolContext, ToolDefinition } from "../types.js";

// ============================================
// OAuth Config Types
// ============================================

export type TokenContentType =
  | "application/x-www-form-urlencoded"
  | "application/json";

export type ClientAuthMethod = "client_secret_post" | "client_secret_basic";

/**
 * OAuth configuration for a provider.
 * Describes how to obtain and refresh access tokens.
 */
export interface IntegrationOAuthConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  scopeSeparator?: string;

  /** How to send client credentials during token exchange */
  clientAuthMethod: ClientAuthMethod;
  tokenContentType: TokenContentType;
  tokenGrantType?: string;
  tokenBodyParams?: string[];
  tokenHeaders?: Record<string, string>;

  /** Extra params appended to the authorization URL */
  authUrlExtraParams?: Record<string, string>;

  /** Field names in the token response */
  accessTokenField?: string;
  refreshTokenField?: string;
  expiresInField?: string;
  tokenTypeField?: string;

  /** Refresh token config (falls back to token config if not set) */
  refreshUrl?: string;
  refreshClientAuthMethod?: ClientAuthMethod;
  refreshContentType?: TokenContentType;
  refreshGrantType?: string;
  refreshBodyParams?: string[];
  refreshHeaders?: Record<string, string>;
}

// ============================================
// API Config Types
// ============================================

export interface IntegrationApiAuthConfig {
  type: "bearer" | "basic" | "header";
  headerName?: string;
  prefix?: string;
}

export interface IntegrationApiConfig {
  baseUrl: string;
  docsUrl?: string;
  defaultHeaders?: Record<string, string>;
  auth: IntegrationApiAuthConfig;
}

// ============================================
// Provider Config
// ============================================

/**
 * Full provider configuration tying OAuth + API together.
 */
export interface ProviderConfig {
  id: string;
  name: string;
  type: "rest" | "graphql" | "agent-registry";
  /**
   * Scope of the integration:
   * - 'user': per-user tokens (Slack, Notion, Linear)
   * - 'tenant': shared org-wide token (Datadog, AWS)
   */
  scope?: "user" | "tenant";
  docs?: { llmsTxt?: string; human?: string[] };
  auth?: IntegrationOAuthConfig;
  api: IntegrationApiConfig;
}

// ============================================
// Call Input Types (discriminated union)
// ============================================

export interface RestCallInput {
  provider: string;
  type: "rest";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}

export interface GraphqlCallInput {
  provider: string;
  type: "graphql";
  query: string;
  variables?: Record<string, unknown>;
}

export interface AgentRegistryCallInput {
  provider: string;
  type: "agent-registry";
  agent: string;
  tool: string;
  params?: Record<string, unknown>;
}

export type IntegrationCallInput =
  | RestCallInput
  | GraphqlCallInput
  | AgentRegistryCallInput;

// ============================================
// User Connection (stored token)
// ============================================

export interface UserConnection {
  userId: string;
  providerId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scopes?: string[];
  connectedAt: number;
}

// ============================================
// Integration Store Interface
// ============================================

/**
 * Pluggable storage backend for integrations.
 * Implement this to use Postgres, VCS, file system, etc.
 */
export interface IntegrationStore {
  // Provider configs
  getProvider(providerId: string): Promise<ProviderConfig | null>;
  listProviders(): Promise<ProviderConfig[]>;
  upsertProvider(config: ProviderConfig): Promise<void>;
  deleteProvider(providerId: string): Promise<boolean>;

  // User connections (OAuth tokens)
  getConnection(
    userId: string,
    providerId: string,
  ): Promise<UserConnection | null>;
  listConnections(userId: string): Promise<UserConnection[]>;
  upsertConnection(connection: UserConnection): Promise<void>;
  deleteConnection(userId: string, providerId: string): Promise<boolean>;
}

// ============================================
// In-Memory Integration Store
// ============================================

export function createInMemoryIntegrationStore(): IntegrationStore {
  const providers = new Map<string, ProviderConfig>();
  const connections = new Map<string, UserConnection>(); // key: `${userId}:${providerId}`

  function connKey(userId: string, providerId: string): string {
    return `${userId}:${providerId}`;
  }

  return {
    async getProvider(providerId) {
      return providers.get(providerId) ?? null;
    },
    async listProviders() {
      return Array.from(providers.values());
    },
    async upsertProvider(config) {
      providers.set(config.id, config);
    },
    async deleteProvider(providerId) {
      return providers.delete(providerId);
    },
    async getConnection(userId, providerId) {
      return connections.get(connKey(userId, providerId)) ?? null;
    },
    async listConnections(userId) {
      return Array.from(connections.values()).filter(
        (c) => c.userId === userId,
      );
    },
    async upsertConnection(connection) {
      connections.set(
        connKey(connection.userId, connection.providerId),
        connection,
      );
    },
    async deleteConnection(userId, providerId) {
      return connections.delete(connKey(userId, providerId));
    },
  };
}

// ============================================
// Token Exchange Helpers
// ============================================

const DEFAULT_TOKEN_BODY_PARAMS: Record<ClientAuthMethod, string[]> = {
  client_secret_post: [
    "grant_type",
    "code",
    "redirect_uri",
    "client_id",
    "client_secret",
  ],
  client_secret_basic: ["grant_type", "code", "redirect_uri"],
};

const DEFAULT_REFRESH_BODY_PARAMS: Record<ClientAuthMethod, string[]> = {
  client_secret_post: [
    "grant_type",
    "refresh_token",
    "client_id",
    "client_secret",
  ],
  client_secret_basic: ["grant_type", "refresh_token"],
};

export function getDefaultTokenBodyParams(method: ClientAuthMethod): string[] {
  return DEFAULT_TOKEN_BODY_PARAMS[method];
}

export function getDefaultRefreshBodyParams(
  method: ClientAuthMethod,
): string[] {
  return DEFAULT_REFRESH_BODY_PARAMS[method];
}

function buildBasicAuth(clientId: string, clientSecret: string): string {
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  return `Basic ${encoded}`;
}

function buildAuthHeaders(
  config: ProviderConfig,
  accessToken: string,
): Record<string, string> {
  const { auth } = config.api;
  const headerName = auth.headerName ?? "Authorization";
  const prefix = auth.prefix ?? "Bearer";

  return auth.type === "bearer" || auth.type === "header"
    ? { [headerName]: `${prefix} ${accessToken}` }
    : { [headerName]: buildBasicAuth(accessToken, "") };
}

// ============================================
// OAuth Token Exchange
// ============================================

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
}

export async function exchangeCodeForToken(
  config: ProviderConfig,
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<TokenExchangeResult> {
  if (!config.auth)
    throw new Error(`Provider ${config.id} has no OAuth config`);
  const oauth = config.auth;

  const grantType = oauth.tokenGrantType ?? "authorization_code";
  const bodyParams =
    oauth.tokenBodyParams ?? getDefaultTokenBodyParams(oauth.clientAuthMethod);

  const allParams: Record<string, string> = {
    grant_type: grantType,
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  };

  const body: Record<string, string> = {};
  for (const key of bodyParams) {
    if (allParams[key]) body[key] = allParams[key];
  }

  const headers: Record<string, string> = {
    "Content-Type": oauth.tokenContentType,
    ...(oauth.tokenHeaders ?? {}),
  };

  if (oauth.clientAuthMethod === "client_secret_basic") {
    headers.Authorization = buildBasicAuth(clientId, clientSecret);
  }

  const fetchBody =
    oauth.tokenContentType === "application/x-www-form-urlencoded"
      ? new URLSearchParams(body).toString()
      : JSON.stringify(body);

  const response = await fetch(oauth.tokenUrl, {
    method: "POST",
    headers,
    body: fetchBody,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  return {
    accessToken: String(data[oauth.accessTokenField ?? "access_token"] ?? ""),
    refreshToken: data[oauth.refreshTokenField ?? "refresh_token"] as
      | string
      | undefined,
    expiresIn: data[oauth.expiresInField ?? "expires_in"] as number | undefined,
    tokenType: data[oauth.tokenTypeField ?? "token_type"] as string | undefined,
  };
}

export async function refreshAccessToken(
  config: ProviderConfig,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<TokenExchangeResult> {
  if (!config.auth)
    throw new Error(`Provider ${config.id} has no OAuth config`);
  const oauth = config.auth;

  const url = oauth.refreshUrl ?? oauth.tokenUrl;
  const grantType = oauth.refreshGrantType ?? "refresh_token";
  const method = oauth.refreshClientAuthMethod ?? oauth.clientAuthMethod;
  const contentType = oauth.refreshContentType ?? oauth.tokenContentType;
  const bodyParams =
    oauth.refreshBodyParams ?? getDefaultRefreshBodyParams(method);

  const allParams: Record<string, string> = {
    grant_type: grantType,
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  };

  const body: Record<string, string> = {};
  for (const key of bodyParams) {
    if (allParams[key]) body[key] = allParams[key];
  }

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    ...(oauth.refreshHeaders ?? oauth.tokenHeaders ?? {}),
  };

  if (method === "client_secret_basic") {
    headers.Authorization = buildBasicAuth(clientId, clientSecret);
  }

  const fetchBody =
    contentType === "application/x-www-form-urlencoded"
      ? new URLSearchParams(body).toString()
      : JSON.stringify(body);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: fetchBody,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  return {
    accessToken: String(data[oauth.accessTokenField ?? "access_token"] ?? ""),
    refreshToken: data[oauth.refreshTokenField ?? "refresh_token"] as
      | string
      | undefined,
    expiresIn: data[oauth.expiresInField ?? "expires_in"] as number | undefined,
    tokenType: data[oauth.tokenTypeField ?? "token_type"] as string | undefined,
  };
}

// ============================================
// API Call Execution
// ============================================

async function executeRestCall(
  config: ProviderConfig,
  input: RestCallInput,
  accessToken: string,
): Promise<unknown> {
  const url = new URL(input.path, config.api.baseUrl);
  if (input.query) {
    for (const [k, v] of Object.entries(input.query)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    ...buildAuthHeaders(config, accessToken),
    ...(config.api.defaultHeaders ?? {}),
  };

  if (input.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url.toString(), {
    method: input.method,
    headers,
    body: input.body ? JSON.stringify(input.body) : undefined,
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: response.status, body: text };
  }
}

async function executeGraphqlCall(
  config: ProviderConfig,
  input: GraphqlCallInput,
  accessToken: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(config, accessToken),
    ...(config.api.defaultHeaders ?? {}),
  };

  const response = await fetch(config.api.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: input.query, variables: input.variables }),
  });

  return response.json();
}

// ============================================
// Create Integrations Agent Options
// ============================================

export interface IntegrationsAgentOptions {
  /** Integration store backend */
  store: IntegrationStore;

  /** Secret store for storing/resolving client credentials and tokens */
  secretStore: {
    store(value: string, ownerId: string): Promise<string>;
    resolve(id: string, ownerId: string): Promise<string | null>;
    delete(id: string, ownerId: string): Promise<boolean>;
  };

  /**
   * Base URL for OAuth callbacks.
   * The callback URL will be: `${callbackBaseUrl}/${providerId}`
   */
  callbackBaseUrl?: string;
}


// ============================================
// Credential Storage Helpers
// ============================================



const SYSTEM_OWNER = "__integrations__";

// ============================================
// Create Integrations Agent
// ============================================

export function createIntegrationsAgent(
  options: IntegrationsAgentOptions,
): AgentDefinition {
  const { store, callbackBaseUrl, secretStore } = options;

  // ---- setup_integration ----
  const setupTool = defineTool({
    name: "setup_integration",
    description:
      "Create or update an integration provider config. " +
      "Registers a third-party API (REST, GraphQL, or agent-registry) " +
      "with its OAuth and API configuration.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Provider ID (e.g. 'linear', 'notion')",
        },
        name: { type: "string", description: "Display name" },
        type: {
          type: "string",
          enum: ["rest", "graphql", "agent-registry"],
          description: "Integration type",
        },
        scope: {
          type: "string",
          enum: ["user", "tenant"],
          description:
            "'user' for per-user tokens, 'tenant' for shared org-wide. Default: user",
        },
        api: {
          type: "object",
          description: "API config: baseUrl, auth type, default headers",
          properties: {
            baseUrl: { type: "string", description: "API base URL" },
            docsUrl: { type: "string", description: "API docs URL" },
            defaultHeaders: {
              type: "object",
              description: "Default headers for all requests",
              additionalProperties: { type: "string" },
            },
            auth: {
              type: "object",
              description: "Auth config",
              properties: {
                type: { type: "string", enum: ["bearer", "basic", "header"] },
                headerName: { type: "string" },
                prefix: { type: "string" },
              },
              required: ["type"],
            },
          },
          required: ["baseUrl", "auth"],
        },
        auth: {
          type: "object",
          description:
            "OAuth config (optional — omit for token-less integrations)",
          properties: {
            authUrl: { type: "string" },
            tokenUrl: { type: "string" },
            scopes: { type: "array", items: { type: "string" } },
            scopeSeparator: { type: "string" },
            clientAuthMethod: {
              type: "string",
              enum: ["client_secret_post", "client_secret_basic"],
            },
            tokenContentType: {
              type: "string",
              enum: ["application/x-www-form-urlencoded", "application/json"],
            },
            tokenGrantType: { type: "string" },
            tokenBodyParams: { type: "array", items: { type: "string" } },
            tokenHeaders: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            authUrlExtraParams: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            accessTokenField: { type: "string" },
            refreshTokenField: { type: "string" },
            expiresInField: { type: "string" },
            tokenTypeField: { type: "string" },
            refreshUrl: { type: "string" },
            refreshClientAuthMethod: {
              type: "string",
              enum: ["client_secret_post", "client_secret_basic"],
            },
            refreshContentType: {
              type: "string",
              enum: ["application/x-www-form-urlencoded", "application/json"],
            },
            refreshGrantType: { type: "string" },
            refreshBodyParams: { type: "array", items: { type: "string" } },
            refreshHeaders: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
        },
        docs: {
          type: "object",
          description: "Documentation links",
          properties: {
            llmsTxt: { type: "string" },
            human: { type: "array", items: { type: "string" } },
          },
        },
        clientId: {
          type: "string",
          description: "OAuth client ID for this provider. Stored encrypted.",
        },
        clientSecret: {
          type: "string",
          description: "OAuth client secret for this provider. Stored encrypted.",
        },
      },
      required: ["id", "name", "type", "api"],
    },
    execute: async (input: any, _ctx: ToolContext) => {
      const config: ProviderConfig = {
        id: input.id,
        name: input.name,
        type: input.type,
        scope: input.scope,
        docs: input.docs,
        auth: input.auth,
        api: input.api,
      };
      // Store client credentials encrypted and save secret IDs
      const result: Record<string, unknown> = { success: true };
      if (input.clientId) {
        const secretId = await secretStore.store(input.clientId, SYSTEM_OWNER);
        (config as any)._clientIdSecretId = secretId;
        result.clientIdStored = true;
      }
      if (input.clientSecret) {
        const secretId = await secretStore.store(input.clientSecret, SYSTEM_OWNER);
        (config as any)._clientSecretSecretId = secretId;
        result.clientSecretStored = true;
      }

      await store.upsertProvider(config);
      result.provider = config;
      return result;
    },
  });

  // ---- list_integrations ----
  const listTool = defineTool({
    name: "list_integrations",
    description:
      "List configured integration providers and user's connections.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        userId: {
          type: "string",
          description: "User ID to check connections for (optional)",
        },
      },
    },
    execute: async (input: { userId?: string }, ctx: ToolContext) => {
      const providers = await store.listProviders();
      const userId = input.userId ?? ctx.callerId;
      const connections = userId ? await store.listConnections(userId) : [];

      return {
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          scope: p.scope ?? "user",
          hasOAuth: !!p.auth,
          connected: connections.some((c) => c.providerId === p.id),
        })),
        connections: connections.map((c) => ({
          providerId: c.providerId,
          connectedAt: c.connectedAt,
          expiresAt: c.expiresAt,
        })),
      };
    },
  });

  // ---- get_integration ----
  const getTool = defineTool({
    name: "get_integration",
    description: "Get a specific integration provider config.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        provider: { type: "string", description: "Provider ID" },
      },
      required: ["provider"],
    },
    execute: async (input: { provider: string }, _ctx: ToolContext) => {
      const config = await store.getProvider(input.provider);
      if (!config) return { error: `Provider '${input.provider}' not found` };
      return { provider: config };
    },
  });

  // ---- connect_integration ----
  const connectTool = defineTool({
    name: "connect_integration",
    description:
      "Generate an OAuth authorization URL for a user to connect an integration. " +
      "Returns the URL the user should visit to authorize.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        provider: { type: "string", description: "Provider ID to connect" },
        userId: {
          type: "string",
          description: "User ID (optional, defaults to caller)",
        },
        state: {
          type: "string",
          description: "Optional state param for the OAuth flow",
        },
      },
      required: ["provider"],
    },
    execute: async (
      input: { provider: string; userId?: string; state?: string },
      ctx: ToolContext,
    ) => {
      const config = await store.getProvider(input.provider);
      if (!config) return { error: `Provider '${input.provider}' not found` };
      if (!config.auth)
        return { error: `Provider '${input.provider}' has no OAuth config` };
      if (!callbackBaseUrl)
        return { error: "No callbackBaseUrl configured for OAuth flows" };

      const oauth = config.auth;
      const redirectUri = `${callbackBaseUrl}/${config.id}`;
      const userId = input.userId ?? ctx.callerId;

      // Resolve client ID from secret store via config
      const cidSecretId = (config as any)._clientIdSecretId;
      if (!cidSecretId) {
        return {
          error: `No client credentials stored for '${config.id}'. Use setup_integration with clientId and clientSecret params first.`,
        };
      }
      const clientId = await secretStore.resolve(cidSecretId, SYSTEM_OWNER);
      if (!clientId) {
        return { error: `Could not resolve client ID for '${config.id}'.` };
      }

      const separator = oauth.scopeSeparator ?? " ";
      const scopeStr = oauth.scopes.join(separator);

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        ...(scopeStr ? { scope: scopeStr } : {}),
        state: input.state ?? JSON.stringify({ userId, providerId: config.id }),
        ...(oauth.authUrlExtraParams ?? {}),
      });

      return {
        authUrl: `${oauth.authUrl}?${params.toString()}`,
        redirectUri,
        provider: config.id,
      };
    },
  });

  // ---- call_integration ----
  const callTool = defineTool({
    name: "call_integration",
    description:
      "Call a configured integration API. Supports REST, GraphQL, and agent-registry types. " +
      "Automatically injects the user's access token.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        provider: { type: "string", description: "Provider ID" },
        type: {
          type: "string",
          enum: ["rest", "graphql", "agent-registry"],
          description: "Call type",
        },
        // REST fields
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        },
        path: { type: "string", description: "API path (for REST)" },
        body: {
          type: "object",
          description: "Request body (for REST POST/PUT/PATCH)",
        },
        query: {
          type: "object",
          description: "Query params (for REST)",
          additionalProperties: { type: "string" },
        },
        // GraphQL fields
        graphqlQuery: { type: "string", description: "GraphQL query string" },
        variables: { type: "object", description: "GraphQL variables" },
        // Agent-registry fields
        agent: {
          type: "string",
          description: "Agent path (for agent-registry)",
        },
        tool: { type: "string", description: "Tool name (for agent-registry)" },
        params: {
          type: "object",
          description: "Tool params (for agent-registry)",
        },
      },
      required: ["provider", "type"],
    },
    execute: async (input: any, ctx: ToolContext) => {
      const config = await store.getProvider(input.provider);
      if (!config) return { error: `Provider '${input.provider}' not found` };

      const userId = ctx.callerId;

      // Get access token
      const connection = await store.getConnection(userId, input.provider);
      if (!connection) {
        return {
          error: `Not connected to '${input.provider}'. Use connect_integration first.`,
          hint: "connect_integration",
        };
      }

      // Check if token needs refresh
      let accessToken = connection.accessToken;
      if (
        connection.expiresAt &&
        connection.expiresAt < Date.now() &&
        connection.refreshToken
      ) {
        try {
          const rCidId = (config as any)._clientIdSecretId;
          const rCsecId = (config as any)._clientSecretSecretId;
          if (!rCidId || !rCsecId) {
            throw new Error("No client credentials stored. Re-run setup_integration with clientId/clientSecret.");
          }
          const clientId = await secretStore.resolve(rCidId, SYSTEM_OWNER);
          const clientSecret = await secretStore.resolve(rCsecId, SYSTEM_OWNER);
          if (!clientId || !clientSecret) {
            throw new Error("Failed to resolve client credentials from secret store.");
          }

          const refreshed = await refreshAccessToken(
            config,
            connection.refreshToken,
            clientId,
            clientSecret,
          );
          accessToken = refreshed.accessToken;

          // Update stored connection
          await store.upsertConnection({
            ...connection,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? connection.refreshToken,
            expiresAt: refreshed.expiresIn
              ? Date.now() + refreshed.expiresIn * 1000
              : connection.expiresAt,
          });
        } catch (err) {
          return {
            error: `Token refresh failed for '${input.provider}': ${err instanceof Error ? err.message : String(err)}`,
            hint: "connect_integration",
          };
        }
      }

      // Execute the call
      switch (input.type) {
        case "rest":
          return executeRestCall(
            config,
            {
              provider: input.provider,
              type: "rest",
              method: input.method ?? "GET",
              path: input.path ?? "/",
              body: input.body,
              query: input.query,
            },
            accessToken,
          );

        case "graphql":
          return executeGraphqlCall(
            config,
            {
              provider: input.provider,
              type: "graphql",
              query: input.graphqlQuery ?? input.query ?? "",
              variables: input.variables,
            },
            accessToken,
          );

        case "agent-registry": {
          // For agent-registry, forward the call to the remote agent server
          const baseUrl = config.api.baseUrl;
          const response = await fetch(`${baseUrl}/call`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...buildAuthHeaders(config, accessToken),
            },
            body: JSON.stringify({
              action: "execute_tool",
              path: input.agent,
              tool: input.tool,
              params: input.params ?? {},
            }),
          });
          return response.json();
        }

        default:
          return { error: `Unknown integration type: ${input.type}` };
      }
    },
  });

  // ---- handle_callback (OAuth callback handler) ----
  const callbackTool = defineTool({
    name: "handle_oauth_callback",
    description:
      "Handle an OAuth callback. Exchanges the authorization code for tokens and stores the connection. " +
      "This is typically called by the HTTP server when the OAuth redirect hits the callback URL.",
    visibility: "internal" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        provider: { type: "string", description: "Provider ID" },
        code: {
          type: "string",
          description: "Authorization code from the OAuth redirect",
        },
        state: {
          type: "string",
          description: "State param from the OAuth redirect",
        },
      },
      required: ["provider", "code"],
    },
    execute: async (
      input: { provider: string; code: string; state?: string },
      ctx: ToolContext,
    ) => {
      const config = await store.getProvider(input.provider);
      if (!config) return { error: `Provider '${input.provider}' not found` };
      if (!config.auth)
        return { error: `Provider '${input.provider}' has no OAuth config` };
      if (!callbackBaseUrl) return { error: "No callbackBaseUrl configured" };

      // Parse state to get userId
      let userId = ctx.callerId;
      if (input.state) {
        try {
          const parsed = JSON.parse(input.state);
          if (parsed.userId) userId = parsed.userId;
        } catch {}
      }

      // Resolve client credentials from secret store via config
      const cbCidId = (config as any)._clientIdSecretId;
      const cbCsecId = (config as any)._clientSecretSecretId;
      if (!cbCidId || !cbCsecId) {
        return { error: "No client credentials stored for this provider." };
      }
      const clientId = await secretStore.resolve(cbCidId, SYSTEM_OWNER);
      const clientSecret = await secretStore.resolve(cbCsecId, SYSTEM_OWNER);
      if (!clientId || !clientSecret) {
        return { error: "Failed to resolve client credentials." };
      }

      const redirectUri = `${callbackBaseUrl}/${config.id}`;
      const result = await exchangeCodeForToken(
        config,
        input.code,
        redirectUri,
        clientId,
        clientSecret,
      );

      const connection: UserConnection = {
        userId,
        providerId: config.id,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresIn
          ? Date.now() + result.expiresIn * 1000
          : undefined,
        tokenType: result.tokenType,
        scopes: config.auth.scopes,
        connectedAt: Date.now(),
      };

      await store.upsertConnection(connection);

      return {
        success: true,
        provider: config.id,
        userId,
        connectedAt: connection.connectedAt,
      };
    },
  });

  // ---- collect_secrets ----
  const collectSecretsTool = defineTool({
    name: "collect_secrets",
    description:
      "Collect secrets and missing fields for a tool via a secure form. " +
      "Pass the target agent + tool + any params you already have. " +
      "Returns a form spec with fields the user needs to fill in. " +
      "Secrets bypass the LLM entirely. On form submission, the server auto-calls the target tool.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string", description: "Target agent path (e.g. '@db-connections')" },
        tool: { type: "string", description: "Target tool name (e.g. 'add_connection')" },
        params: { type: "object", description: "Partial params already collected" },
        registry: { type: "string", description: "Remote registry URL. Omit for local." },
      },
      required: ["agent", "tool"],
    },
    execute: async (
      input: { agent: string; tool: string; params?: Record<string, unknown>; registry?: string },
      ctx: ToolContext,
    ) => {
      // Fetch tool schema from registry
      let toolSchema: { name: string; inputSchema?: any; description?: string } | null = null;
      const registryUrl = input.registry;

      if (!registryUrl) {
        return { error: "Registry URL required for now. Pass registry param." };
      }

      const res = await fetch(registryUrl + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "tools/call",
          params: {
            name: "call_agent",
            arguments: { request: { action: "describe_tools", path: input.agent } },
          },
        }),
      });
      const data = (await res.json()) as any;
      const parsed = JSON.parse(data?.result?.content?.[0]?.text ?? "{}");
      const tools = parsed?.tools ?? parsed?.result?.tools ?? [];
      toolSchema = tools.find((t: any) => t.name === input.tool) ?? null;

      if (!toolSchema?.inputSchema) {
        return { error: `Tool '${input.tool}' not found on '${input.agent}'` };
      }

      const schema = toolSchema.inputSchema;
      const properties = schema.properties ?? {};
      const requiredFields = new Set<string>(schema.required ?? []);
      const providedParams = input.params ?? {};

      // Compute fields: secret fields always, required fields if not provided
      const fields: Array<{
        name: string; type: string; description: string; secret: boolean; required: boolean;
      }> = [];

      for (const [name, def] of Object.entries(properties) as [string, any][]) {
        const isSecret = def.secret === true;
        const isRequired = requiredFields.has(name);
        const isProvided = name in providedParams;
        if (isSecret || (isRequired && !isProvided)) {
          fields.push({
            name,
            type: def.type ?? "string",
            description: def.description ?? name,
            secret: isSecret,
            required: isRequired,
          });
        }
      }

      if (fields.length === 0) {
        return { message: "All fields provided. Call the tool directly.", canCallDirectly: true };
      }

      // Register pending collection
      const token = generateCollectionToken();
      pendingCollections.set(token, {
        params: providedParams as Record<string, unknown>,
        agent: input.agent,
        tool: input.tool,
        auth: {
          callerId: ctx.callerId,
          callerType: ctx.callerType as "agent" | "user" | "system",
          scopes: [],
          isRoot: false,
        },
        fields: fields.map((f) => ({
          name: f.name, description: f.description, secret: f.secret, required: f.required,
        })),
        createdAt: Date.now(),
      });

      // Build callback URL from callbackBaseUrl
      const baseUrl = callbackBaseUrl?.replace(/\/integrations\/callback$/, "") ?? "";

      return {
        formSpec: {
          fields,
          callbackUrl: `${baseUrl}/secrets/collect`,
          callbackToken: token,
          expiresIn: 600,
          context: {
            agent: input.agent,
            tool: input.tool,
            description: toolSchema.description,
          },
        },
      };
    },
  });

  return defineAgent({
    path: "@integrations",
    entrypoint:
      "You are the integrations agent. You manage third-party API integrations " +
      "including OAuth connections, provider configs, and API calling.",
    config: {
      name: "Integrations",
      description: "Third-party API integration management with OAuth2 support",
      supportedActions: ["execute_tool", "describe_tools", "load"],
    },
    visibility: "public",
    tools: [
      setupTool,
      listTool,
      getTool,
      connectTool,
      callTool,
      callbackTool,
      collectSecretsTool,
    ] as ToolDefinition[],
  });
}
