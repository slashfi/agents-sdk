/**
 * Agent Server (MCP over HTTP)
 *
 * JSON-RPC server implementing the MCP protocol for agent interaction.
 * Compatible with atlas-environments and any MCP client.
 *
 * MCP Methods:
 * - initialize       → Protocol handshake
 * - tools/list        → List available MCP tools (call_agent, list_agents)
 * - tools/call        → Execute an MCP tool
 *
 * MCP Tools exposed:
 * - call_agent   → Execute a tool on a registered agent
 * - list_agents  → List registered agents and their tools
 *
 * Additional endpoints:
 * - POST /oauth/token → OAuth2 client_credentials (when @auth registered)
 * - GET /health       → Health check
 *
 * Auth Integration:
 * When an `@auth` agent is registered, the server automatically:
 * - Validates Bearer tokens on requests
 * - Resolves tokens to identity + scopes
 * - Populates caller context from headers (X-Atlas-Actor-Id, etc.)
 * - Recognizes the root key for admin access
 */

import type { AuthStore } from "./agent-definitions/auth.js";
import {
  type SecretStore,
  processSecretParams,
} from "./agent-definitions/secrets.js";
import { verifyJwt } from "./jwt.js";
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
}

export interface AgentServer {
  /** Start the server */
  start(): Promise<void>;
  /** Stop the server */
  stop(): Promise<void>;
  /** Handle a request (for custom integrations) */
  fetch(req: Request): Promise<Response>;
  /** Get the server URL (only available after start) */
  url: string | null;
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
// Auth Types
// ============================================

interface AuthConfig {
  store: AuthStore;
  rootKey: string;
  tokenTtl: number;
}

interface ResolvedAuth {
  callerId: string;
  callerType: "agent" | "user" | "system";
  scopes: string[];
  isRoot: boolean;
}


// ============================================
// Secrets Collection (one-time tokens)
// ============================================

export interface PendingCollection {
  /** Partial params already provided by agent */
  params: Record<string, unknown>;
  /** Target agent + tool to call after collection */
  agent: string;
  tool: string;
  /** Auth context from original request */
  auth: ResolvedAuth | null;
  /** Fields the form needs to collect */
  fields: Array<{ name: string; description?: string; secret: boolean; required: boolean }>;
  /** Created timestamp for expiry */
  createdAt: number;
}

export const pendingCollections = new Map<string, PendingCollection>();

export function generateCollectionToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "sc_";
  for (let i = 0; i < 32; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// ============================================
// Helpers
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
      "Content-Type, Authorization, X-Atlas-Actor-Id, X-Atlas-Agent-Id, X-Atlas-Session-Id",
  };
}

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
// Auth Detection
// ============================================

function detectAuth(registry: AgentRegistry): AuthConfig | null {
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

async function resolveAuth(
  req: Request,
  authConfig: AuthConfig,
): Promise<ResolvedAuth | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const [scheme, credential] = authHeader.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !credential) return null;

  if (credential === authConfig.rootKey) {
    return {
      callerId: "root",
      callerType: "system",
      scopes: ["*"],
      isRoot: true,
    };
  }

  // Try JWT verification first (stateless)
  // JWT is signed with the client's secret hash
  // Decode payload to get client_id, look up client, verify signature
  const parts = credential.split(".");
  if (parts.length === 3) {
    // Looks like a JWT - decode payload to get client_id
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
        // Look up client to get the signing secret (secret hash)
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

function canSeeAgent(
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
                description: "Agent path (e.g. '@registry')",
              },
              tool: {
                type: "string",
                description: "Tool name to call (for execute_tool)",
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
      description: "List all registered agents and their available tools.",
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

  let serverInstance: ReturnType<typeof Bun.serve> | null = null;
  let serverUrl: string | null = null;

  const authConfig = detectAuth(registry);

  // ──────────────────────────────────────────
  // MCP JSON-RPC handler
  // ──────────────────────────────────────────

  async function handleJsonRpc(
    request: JsonRpcRequest,
    auth: ResolvedAuth | null,
  ): Promise<JsonRpcResponse> {
    switch (request.method) {
      // MCP protocol handshake
      case "initialize":
        return jsonRpcSuccess(request.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: serverVersion },
        });

      case "notifications/initialized":
        return jsonRpcSuccess(request.id, {});

      // List MCP tools
      case "tools/list":
        return jsonRpcSuccess(request.id, {
          tools: getToolDefinitions(),
        });

      // Call an MCP tool
      case "tools/call": {
        const { name, arguments: args } = (request.params ?? {}) as {
          name: string;
          arguments?: Record<string, unknown>;
        };

        try {
          const result = await handleToolCall(name, args ?? {}, auth);
          return jsonRpcSuccess(request.id, result);
        } catch (err) {
          console.error("[server] Request error:", err);
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
          // Find the tool schema to check for secret: true fields
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
            tools: agent.tools
              .filter((t) => {
                const tv = t.visibility ?? "internal";
                if (auth?.isRoot) return true;
                if (tv === "public") return true;
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
  // OAuth2 token handler (unchanged)
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

    const client = await authConfig.store.validateClient(
      clientId,
      clientSecret,
    );
    if (!client) {
      return jsonResponse(
        {
          error: "invalid_client",
          error_description: "Invalid client credentials",
        },
        401,
      );
    }

    const tokenString = `at_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const now = Date.now();

    await authConfig.store.storeToken({
      token: tokenString,
      clientId: client.clientId,
      scopes: client.scopes,
      issuedAt: now,
      expiresAt: now + authConfig.tokenTtl * 1000,
    });

    return jsonResponse({
      access_token: tokenString,
      token_type: "Bearer",
      expires_in: authConfig.tokenTtl,
      scope: client.scopes.join(" "),
    });
  }

  // ──────────────────────────────────────────
  // HTTP request handler
  // ─��────────────────────────────────────────

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(basePath, "") || "/";

    // CORS preflight
    if (cors && req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const addCors = (response: Response): Response => {
      if (!cors) return response;
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders())) {
        headers.set(key, value);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };

    const auth = authConfig ? await resolveAuth(req, authConfig) : null;

    try {
      // MCP endpoint: POST / or POST /mcp
      if ((path === "/" || path === "/mcp") && req.method === "POST") {
        const body = (await req.json()) as JsonRpcRequest;
        const response = await handleJsonRpc(body, auth);
        return addCors(jsonResponse(response));
      }

      // OAuth2 token endpoint
      if (path === "/oauth/token" && req.method === "POST") {
        return addCors(await handleOAuthToken(req));
      }

      // Health check
      if (path === "/health" && req.method === "GET") {
        return addCors(jsonResponse({ status: "ok" }));
      }

      // Backwards compat: GET /list (returns agents directly)
      if (path === "/list" && req.method === "GET") {
        const agents = registry.list();
        const visible = agents.filter((agent) => canSeeAgent(agent, auth));
        return addCors(
          jsonResponse({
            success: true,
            agents: visible.map((agent) => ({
              path: agent.path,
              name: agent.config?.name,
              description: agent.config?.description,
              supportedActions: agent.config?.supportedActions,
              tools: agent.tools
                .filter((t) => {
                  const tv = t.visibility ?? "internal";
                  if (auth?.isRoot) return true;
                  if (tv === "public") return true;
                  if (tv === "internal" && auth) return true;
                  return false;
                })
                .map((t) => t.name),
            })),
          }),
        );
      }


      // POST /secrets/collect - Submit collected secrets and auto-forward to tool
      if (path === "/secrets/collect" && req.method === "POST") {
        const body = (await req.json()) as {
          token: string;
          values: Record<string, string>;
        };

        const pending = pendingCollections.get(body.token);
        if (!pending) {
          return addCors(
            jsonResponse({ error: "Invalid or expired collection token" }, 400),
          );
        }

        // One-time use
        pendingCollections.delete(body.token);

        // Check expiry (10 min)
        if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
          return addCors(
            jsonResponse({ error: "Collection token expired" }, 400),
          );
        }

        // Encrypt secret values and store as refs
        const mergedParams = { ...pending.params };
        for (const [fieldName, value] of Object.entries(body.values)) {
          const fieldDef = pending.fields.find((f) => f.name === fieldName);
          if (fieldDef?.secret && secretStore) {
            // Store encrypted, get ref
            const ownerId = pending.auth?.callerId ?? "anonymous";
            const secretId = await secretStore.store(value, ownerId);
            mergedParams[fieldName] = `secret:${secretId}`;
          } else {
            mergedParams[fieldName] = value;
          }
        }

        // Auto-forward to the target tool
        const callRequest = {
          action: "execute_tool" as const,
          path: pending.agent,
          tool: pending.tool,
          params: mergedParams,
        };

        const toolCtx = {
          tenantId: "default",
          agentPath: pending.agent,
          callerId: pending.auth?.callerId ?? "anonymous",
          callerType: pending.auth?.callerType ?? ("system" as const),
        };

        const result = await registry.call({
          ...callRequest,
          context: toolCtx,
        } as any);

        return addCors(jsonResponse({ success: true, result }));
      }

      return addCors(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32601,
              message: `Not found: ${req.method} ${path}`,
            },
          },
          404,
        ),
      );
    } catch (err) {
      console.error("[server] Request error:", err);
      return addCors(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: "Internal error" },
          },
          500,
        ),
      );
    }
  }

  // ──────────────────────────────────────────
  // Server lifecycle
  // ──────────────────────────────────────────

  const server: AgentServer = {
    async start(): Promise<void> {
      if (serverInstance) throw new Error("Server is already running");

      serverInstance = Bun.serve({ port, hostname, fetch });
      serverUrl = `http://${hostname}:${port}${basePath}`;

      console.log(`Agent server running at ${serverUrl}`);
      console.log("  POST /     - MCP JSON-RPC endpoint");
      console.log("  POST /mcp  - MCP JSON-RPC endpoint (alias)");
      console.log("  GET  /health - Health check");
      if (authConfig) {
        console.log("  POST /oauth/token - OAuth2 token endpoint");
        console.log("  Auth: enabled");
      }
      console.log("  MCP tools: call_agent, list_agents");
    },

    async stop(): Promise<void> {
      if (serverInstance) {
        serverInstance.stop();
        serverInstance = null;
        serverUrl = null;
      }
    },

    fetch,

    get url(): string | null {
      return serverUrl;
    },
  };

  return server;
}
