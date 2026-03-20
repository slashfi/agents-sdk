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
 * - GET /             → Registry description (markdown, for AI agent discovery)
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
import type { AgentRegistry } from "./registry.js";
import type { AgentDefinition, CallAgentRequest, Visibility } from "./types.js";
import { verifyJwt } from "./jwt.js";
import { type SecretStore, processSecretParams } from "./agent-definitions/secrets.js";

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
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined && { data }) } };
}

/** Wrap a value as MCP tool result content */
function mcpResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
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
    return { callerId: "root", callerType: "system", scopes: ["*"], isRoot: true };
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
      const payload = JSON.parse(atob(padded)) as { sub?: string; name?: string; scopes?: string[]; exp?: number };

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

function canSeeAgent(agent: AgentDefinition, auth: ResolvedAuth | null): boolean {
  const visibility = ((agent as any).visibility ?? agent.config?.visibility ?? "internal") as Visibility;
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
        { error: "unsupported_grant_type", error_description: "Only client_credentials is supported" },
        400,
      );
    }

    if (!clientId || !clientSecret) {
      return jsonResponse(
        { error: "invalid_request", error_description: "Missing client_id or client_secret" },
        400,
      );
    }

    const client = await authConfig.store.validateClient(clientId, clientSecret);
    if (!client) {
      return jsonResponse(
        { error: "invalid_client", error_description: "Invalid client credentials" },
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
  // Registry markdown (GET /)
  // ──────────────────────────────────────────

  function generateRegistryMarkdown(auth: ResolvedAuth | null): string {
    const agents = registry.list();
    const visible = agents.filter((agent) => canSeeAgent(agent, auth));
    const hasAuth = !!authConfig;

    const md: string[] = [];
    md.push(`# ${serverName}`);
    md.push("");
    md.push(
      "This is an agent registry powered by [@slashfi/agents-sdk](https://github.com/slashfi/agents-sdk).",
    );
    md.push("");
    md.push("## Protocol");
    md.push("");
    md.push(
      "This server speaks [MCP](https://modelcontextprotocol.io/) (JSON-RPC) over HTTP.",
    );
    md.push("");
    md.push("| Endpoint | Method | Description |");
    md.push("|----------|--------|-------------|");
    md.push("| `/` | `GET` | This page (plaintext markdown) |");
    md.push("| `/` | `POST` | MCP JSON-RPC endpoint |");
    md.push("| `/mcp` | `POST` | MCP JSON-RPC endpoint (alias) |");
    md.push("| `/list` | `GET` | List agents and tools (JSON) |");
    md.push("| `/health` | `GET` | Health check |");
    if (hasAuth) {
      md.push("| `/oauth/token` | `POST` | OAuth2 token endpoint |");
    }
    md.push("");

    // Auth section
    if (hasAuth) {
      const authAgent = registry.get("@auth");
      const hasRegister = authAgent?.tools.some((t) => t.name === "register");

      md.push("## Authentication");
      md.push("");
      md.push(
        "This registry requires authentication for most operations. It uses OAuth2 client\\_credentials.",
      );
      md.push("");

      if (hasRegister) {
        md.push("### 1. Register a client");
        md.push("");
        md.push("```json");
        md.push("POST /");
        md.push("Content-Type: application/json");
        md.push("");
        md.push("{");
        md.push('  "jsonrpc": "2.0",');
        md.push('  "id": 1,');
        md.push('  "method": "tools/call",');
        md.push('  "params": {');
        md.push('    "name": "call_agent",');
        md.push('    "arguments": {');
        md.push('      "request": {');
        md.push('        "action": "execute_tool",');
        md.push('        "path": "@auth",');
        md.push('        "tool": "register",');
        md.push('        "params": { "name": "my-agent" }');
        md.push("      }");
        md.push("    }");
        md.push("  }");
        md.push("}");
        md.push("```");
        md.push("");
        md.push("This returns a `clientId` and `clientSecret`.");
        md.push("");
        md.push("### 2. Exchange credentials for a token");
      } else {
        md.push(
          "This is a closed registry \u2014 credentials are provisioned by an administrator.",
        );
        md.push("");
        md.push("### Exchange credentials for a token");
      }
      md.push("");
      md.push("```");
      md.push("POST /oauth/token");
      md.push("Content-Type: application/x-www-form-urlencoded");
      md.push("");
      md.push(
        "grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET",
      );
      md.push("```");
      md.push("");
      md.push(
        "This returns an `access_token` (JWT). Include it on subsequent requests:",
      );
      md.push("");
      md.push("```");
      md.push("Authorization: Bearer <access_token>");
      md.push("```");
      md.push("");
    } else {
      md.push("## Authentication");
      md.push("");
      md.push("This registry does not require authentication.");
      md.push("");
    }

    // Agents section
    md.push("## Agents");
    md.push("");
    if (visible.length === 0) {
      md.push(
        "No agents are publicly visible. Authenticate to see more.",
      );
      md.push("");
    } else {
      for (const agent of visible) {
        const desc = agent.config?.description;
        md.push(`### ${agent.path}`);
        if (desc) {
          md.push("");
          md.push(desc);
        }
        md.push("");

        // Show tools visible to this caller
        const visibleTools = agent.tools.filter((t) => {
          const tv = t.visibility ?? "internal";
          if (auth?.isRoot) return true;
          if (tv === "public") return true;
          if (tv === "internal" && auth) return true;
          return false;
        });

        if (visibleTools.length > 0) {
          md.push("| Tool | Description |");
          md.push("|------|-------------|");
          for (const tool of visibleTools) {
            const toolDesc = (tool.description || "")
              .replace(/\|/g, "\\|")
              .replace(/\n/g, " ");
            md.push(`| \`${tool.name}\` | ${toolDesc} |`);
          }
          md.push("");
        } else {
          md.push(
            "_No tools visible. Authenticate to see available tools._",
          );
          md.push("");
        }
      }
    }

    // Calling tools section
    md.push("## Calling a Tool");
    md.push("");
    md.push("Send a JSON-RPC request to `POST /`:");
    md.push("");
    md.push("```json");
    md.push("{");
    md.push('  "jsonrpc": "2.0",');
    md.push('  "id": 1,');
    md.push('  "method": "tools/call",');
    md.push('  "params": {');
    md.push('    "name": "call_agent",');
    md.push('    "arguments": {');
    md.push('      "request": {');
    md.push('        "action": "execute_tool",');
    md.push('        "path": "@agent-path",');
    md.push('        "tool": "tool-name",');
    md.push('        "params": { }');
    md.push("      }");
    md.push("    }");
    md.push("  }");
    md.push("}");
    md.push("```");
    md.push("");
    md.push("To inspect a tool's input schema before calling it:");
    md.push("");
    md.push("```json");
    md.push("{");
    md.push('  "jsonrpc": "2.0",');
    md.push('  "id": 1,');
    md.push('  "method": "tools/call",');
    md.push('  "params": {');
    md.push('    "name": "call_agent",');
    md.push('    "arguments": {');
    md.push('      "request": {');
    md.push('        "action": "describe_tools",');
    md.push('        "path": "@agent-path"');
    md.push("      }");
    md.push("    }");
    md.push("  }");
    md.push("}");
    md.push("```");
    md.push("");

    return md.join("\n");
  }

  // ──────────────────────────────────────────
  // HTTP request handler
  // ─��────────────────────────────────────────

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(basePath, "") || "/";

    // Registry description: GET /
    if (path === "/" && req.method === "GET") {
      const auth = authConfig ? await resolveAuth(req, authConfig) : null;
      const md = generateRegistryMarkdown(auth);
      const headers: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
      };
      if (cors) Object.assign(headers, corsHeaders());
      return new Response(md, { status: 200, headers });
    }

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

      return addCors(jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32601, message: `Not found: ${req.method} ${path}` } }, 404));
    } catch (err) {
      console.error("[server] Request error:", err);
      return addCors(
        jsonResponse(
          { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } },
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
      console.log(`  GET  /     - Registry description (markdown)`);
      console.log(`  POST /     - MCP JSON-RPC endpoint`);
      console.log(`  POST /mcp  - MCP JSON-RPC endpoint (alias)`);
      console.log(`  GET  /health - Health check`);
      if (authConfig) {
        console.log(`  POST /oauth/token - OAuth2 token endpoint`);
        console.log("  Auth: enabled");
      }
      console.log(`  MCP tools: call_agent, list_agents`);
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
