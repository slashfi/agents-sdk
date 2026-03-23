/**
 * Agent Server (MCP over HTTP)
 *
 * Minimal JSON-RPC server implementing the MCP protocol for agent interaction.
 * Handles only core SDK concerns:
 * - MCP protocol (initialize, tools/list, tools/call)
 * - Agent registry routing (call_agent, list_agents)
 * - Auth resolution (Bearer tokens, root key, JWT)
 * - OAuth2 token exchange (client_credentials)
 * - Health check
 * - CORS
 *
 * Application-specific routes (web UI, OAuth callbacks, tenant management)
 * should be built on top using the exported `fetch` handler.
 *
 * @example
 * ```typescript
 * // Standalone usage
 * const server = createAgentServer(registry, { port: 3000 });
 * await server.start();
 *
 * // Composable with any HTTP framework
 * const server = createAgentServer(registry);
 * app.all('/mcp/*', (req) => server.fetch(req));
 * ```
 */

import type { AuthStore } from "./agent-definitions/auth.js";
import {
  type SecretStore,
  processSecretParams,
} from "./agent-definitions/secrets.js";
import { verifyJwt } from "./jwt.js";
import type { SigningKey } from "./jwt.js";
import { generateSigningKey, importSigningKey, exportSigningKey, buildJwks, verifyJwtLocal, verifyJwtFromIssuer } from "./jwt.js";
import type { AgentRegistry } from "./registry.js";
import type { AgentDefinition, CallAgentRequest, Visibility } from "./types.js";

// ============================================
// Server Types
// ============================================

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
  /** URLs of trusted registries for cross-registry JWT verification */
  trustedIssuers?: string[];
  /** Pre-generated signing key (if not provided, one is generated on start) */
  signingKey?: SigningKey;
}

export interface AgentServer {
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
}

// ============================================
// JSON-RPC Types
// ============================================

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ============================================
// Auth Types (exported for use by custom routes)
// ============================================

export interface AuthConfig {
  store: AuthStore;
  rootKey: string;
  tokenTtl: number;
}

export interface ResolvedAuth {
  callerId: string;
  callerType: "agent" | "user" | "system";
  scopes: string[];
  isRoot: boolean;
}

// ============================================
// HTTP Helpers
// ============================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Atlas-Actor-Id, X-Atlas-Actor-Type",
  };
}

function addCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

// ============================================
// JSON-RPC Helpers
// ============================================

function jsonRpcSuccess(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined && { data }) },
  };
}

/** Wrap a value as MCP tool result content */
function mcpResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError && { isError: true }),
  };
}

// ============================================
// Auth Detection & Resolution
// ============================================

export function detectAuth(registry: AgentRegistry): AuthConfig | null {
  const authAgent = registry.get("@auth") as
    | (AgentDefinition & {
        __authStore?: AuthStore;
        __rootKey?: string;
        __tokenTtl?: number;
      })
    | undefined;

  if (!authAgent?.__authStore || !authAgent.__rootKey) return null;

  return {
    store: authAgent.__authStore,
    rootKey: authAgent.__rootKey,
    tokenTtl: authAgent.__tokenTtl ?? 3600,
  };
}

export async function resolveAuth(
  req: Request,
  authConfig: AuthConfig,
  jwksOptions?: { signingKeys?: SigningKey[]; trustedIssuers?: string[] },
): Promise<ResolvedAuth | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const [scheme, credential] = authHeader.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !credential) return null;

  // Root key check
  if (credential === authConfig.rootKey) {
    return {
      callerId: "root",
      callerType: "system",
      scopes: ["*"],
      isRoot: true,
    };
  }

  // Try ES256 verification against own signing keys
  const parts = credential.split(".");
  if (parts.length === 3 && jwksOptions?.signingKeys?.length) {
    for (const key of jwksOptions.signingKeys) {
      try {
        const verified = await verifyJwtLocal(credential, key.publicKey);
        if (verified) {
          return {
            callerId: verified.sub ?? verified.name ?? "unknown",
            callerType: "agent",
            scopes: verified.scopes ?? ["*"],
            isRoot: false,
          };
        }
      } catch {
        continue;
      }
    }
  }

  // Try trusted issuers (remote JWKS verification)
  if (parts.length === 3 && jwksOptions?.trustedIssuers?.length) {
    for (const issuer of jwksOptions.trustedIssuers) {
      try {
        const verified = await verifyJwtFromIssuer(credential, issuer);
        if (verified) {
          return {
            callerId: verified.sub ?? verified.name ?? "unknown",
            callerType: "agent",
            scopes: verified.scopes ?? ["*"],
            isRoot: false,
          };
        }
      } catch {
        continue;
      }
    }
  }

  // Try HMAC JWT verification (legacy, stateless)
  if (parts.length === 3) {
    try {
      const payloadB64 = parts[1];
      const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(padded)) as {
        sub?: string;
        name?: string;
        scopes?: string[];
        exp?: number;
      };

      if (payload.sub) {
        const client = await authConfig.store.getClient(payload.sub);
        if (client) {
          const verified = await verifyJwt(credential, client.clientSecretHash);
          if (verified) {
            return {
              callerId: verified.name || client.name,
              callerType: "agent",
              scopes: verified.scopes,
              isRoot: false,
            };
          }
        }
      }
    } catch {
      // Not a valid JWT, fall through to legacy token validation
    }
  }

  // Legacy: opaque token validation (backwards compat)
  const token = await authConfig.store.validateToken(credential);
  if (!token) return null;

  const client = await authConfig.store.getClient(token.clientId);
  return {
    callerId: client?.name ?? token.clientId,
    callerType: "agent",
    scopes: token.scopes,
    isRoot: false,
  };
}

export function canSeeAgent(
  agent: AgentDefinition,
  auth: ResolvedAuth | null,
): boolean {
  const visibility = ((agent as any).visibility ??
    agent.config?.visibility ??
    "internal") as Visibility;
  if (auth?.isRoot) return true;
  if (visibility === "public") return true;
  if (visibility === "internal" && auth) return true;
  return false;
}

// ============================================
// MCP Tool Definitions
// ============================================

function getToolDefinitions() {
  return [
    {
      name: "call_agent",
      description:
        "Execute a tool on a registered agent. Provide the agent path and tool name.",
      inputSchema: {
        type: "object",
        properties: {
          request: {
            type: "object",
            description: "The call request",
            properties: {
              action: {
                type: "string",
                enum: ["execute_tool", "describe_tools", "load"],
                description: "Action to perform",
              },
              path: {
                type: "string",
                description: "Agent path (e.g., '@my-agent')",
              },
              tool: {
                type: "string",
                description: "Tool name to call",
              },
              params: {
                type: "object",
                description: "Parameters for the tool",
                additionalProperties: true,
              },
            },
            required: ["action", "path"],
          },
        },
        required: ["request"],
      },
    },
    {
      name: "list_agents",
      description:
        "List all registered agents and their available tools.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

// ============================================
// Create Server
// ============================================

export function createAgentServer(
  registry: AgentRegistry,
  options: AgentServerOptions = {},
): AgentServer {
  const {
    port = 3000,
    hostname = "localhost",
    basePath = "",
    cors = true,
    serverName = "agents-sdk",
    serverVersion = "1.0.0",
    secretStore,
  } = options;

  // Signing keys for JWKS-based auth
  const serverSigningKeys: SigningKey[] = [];
  const configTrustedIssuers: string[] = options.trustedIssuers ?? [];

  const authConfig = detectAuth(registry);
  let serverInstance: ReturnType<typeof Bun.serve> | null = null;

  // ──────────────────────────────────────────
  // JSON-RPC handler
  // ──────────────────────────────────────────

  async function handleJsonRpc(
    request: JsonRpcRequest,
    auth: ResolvedAuth | null,
  ): Promise<JsonRpcResponse> {
    switch (request.method) {
      case "initialize":
        return jsonRpcSuccess(request.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: serverVersion },
        });

      case "notifications/initialized":
        return jsonRpcSuccess(request.id, {});

      case "tools/list":
        return jsonRpcSuccess(request.id, {
          tools: getToolDefinitions(),
        });

      case "tools/call": {
        const { name, arguments: args } = (request.params ?? {}) as {
          name: string;
          arguments?: Record<string, unknown>;
        };

        try {
          const result = await handleToolCall(name, args ?? {}, auth);
          return jsonRpcSuccess(request.id, result);
        } catch (err) {
          console.error("[server] Tool call error:", err);
          return jsonRpcSuccess(
            request.id,
            mcpResult(
              `Error: ${err instanceof Error ? err.message : String(err)}`,
              true,
            ),
          );
        }
      }

      default:
        return jsonRpcError(
          request.id,
          -32601,
          `Method not found: ${request.method}`,
        );
    }
  }

  // ──────────────────────────────────────────
  // MCP tool implementations
  // ──────────────────────────────────────────

  async function handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    auth: ResolvedAuth | null,
  ) {
    switch (toolName) {
      case "call_agent": {
        const req = (args.request ?? args) as CallAgentRequest;

        // Inject auth context
        if (auth) {
          req.callerId = auth.callerId;
          req.callerType = auth.callerType;
          if (!req.metadata) req.metadata = {};
          req.metadata.scopes = auth.scopes;
          req.metadata.isRoot = auth.isRoot;
        }
        if (auth?.isRoot) {
          req.callerType = "system";
        }

        // Process secret params: resolve refs, store raw secrets
        if ((req as any).params && secretStore) {
          const ownerId = auth?.callerId ?? "anonymous";
          const agent = registry.get(req.path);
          const tool = agent?.tools.find((t) => t.name === (req as any).tool);
          const schema = tool?.inputSchema as any;
          const { resolved } = await processSecretParams(
            (req as any).params as Record<string, unknown>,
            schema,
            secretStore,
            ownerId,
          );
          (req as any).params = resolved;
        }

        const result = await registry.call(req);
        return mcpResult(result);
      }

      case "list_agents": {
        const agents = registry.list();
        const visible = agents.filter((agent) => canSeeAgent(agent, auth));

        return mcpResult({
          success: true,
          agents: visible.map((agent) => ({
            path: agent.path,
            name: agent.config?.name,
            description: agent.config?.description,
            supportedActions: agent.config?.supportedActions,
            integration: agent.config?.integration || null,
            tools: agent.tools
              .filter((t) => {
                const tv = t.visibility ?? "internal";
                if (auth?.isRoot) return true;
                if (tv === "public") return true;
                if (tv === "authenticated" && auth?.callerId && auth.callerId !== "anonymous") return true;
                if (tv === "internal" && auth) return true;
                return false;
              })
              .map((t) => t.name),
          })),
        });
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ──────────────────────────────────────────
  // OAuth2 token handler
  // ──────────────────────────────────────────

  async function handleOAuthToken(req: Request): Promise<Response> {
    if (!authConfig) {
      return jsonResponse({ error: "auth_not_configured" }, 404);
    }

    const contentType = req.headers.get("Content-Type") ?? "";
    let grantType: string;
    let clientId: string;
    let clientSecret: string;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const body = await req.text();
      const params = new URLSearchParams(body);
      grantType = params.get("grant_type") ?? "";
      clientId = params.get("client_id") ?? "";
      clientSecret = params.get("client_secret") ?? "";
    } else {
      const body = (await req.json()) as Record<string, string>;
      grantType = body.grant_type ?? "";
      clientId = body.client_id ?? "";
      clientSecret = body.client_secret ?? "";
    }

    if (grantType !== "client_credentials") {
      return jsonResponse(
        {
          error: "unsupported_grant_type",
          error_description: "Only client_credentials is supported",
        },
        400,
      );
    }

    if (!clientId || !clientSecret) {
      return jsonResponse(
        {
          error: "invalid_request",
          error_description: "Missing client_id or client_secret",
        },
        400,
      );
    }

    try {
      const result = await registry.call({
        action: "execute_tool",
        path: "@auth",
        tool: "token",
        params: { clientId, clientSecret },
        callerType: "system",
      });

      const tokenResult = (result as any)?.result;
      if (!tokenResult?.accessToken) {
        return jsonResponse(
          { error: "invalid_client", error_description: "Authentication failed" },
          401,
        );
      }

      return jsonResponse({
        access_token: tokenResult.accessToken,
        token_type: "Bearer",
        expires_in: tokenResult.expiresIn ?? authConfig.tokenTtl,
        refresh_token: tokenResult.refreshToken,
      });
    } catch (err) {
      console.error("[oauth] Token error:", err);
      return jsonResponse(
        { error: "server_error", error_description: "Token exchange failed" },
        500,
      );
    }
  }

  // ──────────────────────────────────────────
  // Main fetch handler
  // ──────────────────────────────────────────

  async function fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(basePath, "") || "/";

      // CORS preflight
      if (cors && req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // Resolve auth for all requests
      const auth = authConfig ? await resolveAuth(req, authConfig, {
        signingKeys: serverSigningKeys,
        trustedIssuers: configTrustedIssuers,
      }) : null;

      // Also check header-based identity (for proxied requests)
      const headerAuth: ResolvedAuth | null = !auth
        ? (() => {
            const actorId = req.headers.get("X-Atlas-Actor-Id");
            const actorType = req.headers.get("X-Atlas-Actor-Type");
            if (actorId) {
              return {
                callerId: actorId,
                callerType: (actorType as any) ?? "agent",
                scopes: ["*"],
                isRoot: false,
              };
            }
            return null;
          })()
        : null;

      const effectiveAuth = auth ?? headerAuth;

      // ── POST / → MCP JSON-RPC ──
      if (path === "/" && req.method === "POST") {
        const body = (await req.json()) as JsonRpcRequest;
        const result = await handleJsonRpc(body, effectiveAuth);
        return cors ? addCors(jsonResponse(result)) : jsonResponse(result);
      }

      // ── POST /oauth/token → OAuth2 client_credentials ──
      if (path === "/oauth/token" && req.method === "POST") {
        const res = await handleOAuthToken(req);
        return cors ? addCors(res) : res;
      }

      // ── GET /health → Health check ──
      if (path === "/health" && req.method === "GET") {
        const res = jsonResponse({ status: "ok", agents: registry.listPaths() });
        return cors ? addCors(res) : res;
      }

      // ── GET /.well-known/jwks.json → JWKS public keys ──
      if (path === "/.well-known/jwks.json" && req.method === "GET") {
        const jwks = serverSigningKeys.length > 0
          ? await buildJwks(serverSigningKeys)
          : { keys: [] };
        const res = jsonResponse(jwks);
        return cors ? addCors(res) : res;
      }

      // ── GET /.well-known/configuration → Server discovery ──
      if (path === "/.well-known/configuration" && req.method === "GET") {
        const baseUrl = new URL(req.url).origin;
        const res = jsonResponse({
          issuer: baseUrl,
          jwks_uri: `${baseUrl}/.well-known/jwks.json`,
          token_endpoint: `${baseUrl}/oauth/token`,
          agents_endpoint: `${baseUrl}/list`,
          call_endpoint: baseUrl,
          supported_grant_types: ["client_credentials"],
          agents: registry.listPaths(),
        });
        return cors ? addCors(res) : res;
      }

      // ── GET /list → List agents (legacy endpoint) ──
      if (path === "/list" && req.method === "GET") {
        const agents = registry.list();
        const visible = agents.filter((agent) => canSeeAgent(agent, effectiveAuth));
        const res = jsonResponse(
          visible.map((agent) => ({
            path: agent.path,
            name: agent.config?.name,
            description: agent.config?.description,
            supportedActions: agent.config?.supportedActions,
            integration: agent.config?.integration || null,
            tools: agent.tools
              .filter((t) => {
                const tv = t.visibility ?? "internal";
                if (effectiveAuth?.isRoot) return true;
                if (tv === "public") return true;
                if (tv === "internal" && effectiveAuth) return true;
                return false;
              })
              .map((t) => ({
                name: t.name,
                description: t.description,
              })),
          })),
        );
        return cors ? addCors(res) : res;
      }

      // ── Not found ──
      const res = jsonResponse(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32601,
            message: `Not found: ${req.method} ${path}`,
          },
        },
        404,
      );
      return cors ? addCors(res) : res;
    } catch (err) {
      console.error("[server] Request error:", err);
      const res = jsonResponse(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : "Internal error",
          },
        },
        500,
      );
      return cors ? addCors(res) : res;
    }
  }

  // ──────────────────────────────────────────
  // Server lifecycle
  // ──────────────────────────────────────────

  return {
    url: null,
    registry,

    async start() {
      // Load or generate signing key for JWKS
      if (options.signingKey) {
        serverSigningKeys.push(options.signingKey);
      } else if (authConfig?.store?.getSigningKeys) {
        const stored = await authConfig.store.getSigningKeys() ?? [];
        for (const exported of stored) {
          serverSigningKeys.push(await importSigningKey(exported));
        }
      }
      if (serverSigningKeys.length === 0) {
        const key = await generateSigningKey();
        serverSigningKeys.push(key);
        if (authConfig?.store?.storeSigningKey) {
          await authConfig.store.storeSigningKey(await exportSigningKey(key));
        }
      }

      serverInstance = Bun.serve({
        port,
        hostname,
        fetch,
      });
      (this as any).url = `http://${hostname}:${port}`;
      console.log(`[agents-sdk] Server listening on http://${hostname}:${port}`);
    },

    async stop() {
      if (serverInstance) {
        serverInstance.stop();
        serverInstance = null;
        (this as any).url = null;
      }
    },

    fetch,
  };
}
