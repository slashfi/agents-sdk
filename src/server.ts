/**
 * Agent Server
 *
 * HTTP server that exposes the agent registry via JSON-RPC endpoints.
 * Compatible with MCP (Model Context Protocol) over HTTP.
 *
 * Endpoints:
 * - POST /call - Execute agent actions (execute_tool, describe_tools, load)
 * - GET /list - List registered agents
 * - POST /oauth/token - OAuth2 token endpoint (when @auth is registered)
 *
 * Auth Integration:
 * When an `@auth` agent is registered, the server automatically:
 * - Validates Bearer tokens on requests
 * - Resolves tokens to identity + scopes
 * - Populates callerId, callerType in the request context
 * - Recognizes the root key for admin access
 * - Mounts the /oauth/token endpoint
 */

import type { AuthStore } from "./auth.js";
import type { AgentRegistry } from "./registry.js";
import type { AgentDefinition, CallAgentRequest, Visibility } from "./types.js";

// ============================================
// Server Types
// ============================================

/**
 * Server configuration options.
 */
export interface AgentServerOptions {
  /** Port to listen on (default: 3000) */
  port?: number;

  /** Hostname to bind to (default: 'localhost') */
  hostname?: string;

  /** Base path for endpoints (default: '') */
  basePath?: string;

  /** Enable CORS (default: true) */
  cors?: boolean;

  /** Custom request handler for unmatched routes */
  onNotFound?: (req: Request) => Response | Promise<Response>;
}

/**
 * Agent server instance.
 */
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
// Auth Integration Types
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
// Response Helpers
// ============================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

  // Check root key
  if (credential === authConfig.rootKey) {
    return {
      callerId: "root",
      callerType: "system",
      scopes: ["*"],
      isRoot: true,
    };
  }

  // Validate token
  const token = await authConfig.store.validateToken(credential);
  if (!token) return null;

  // Look up client name
  const client = await authConfig.store.getClient(token.clientId);

  return {
    callerId: client?.name ?? token.clientId,
    callerType: "agent",
    scopes: token.scopes,
    isRoot: false,
  };
}

// ============================================
// Visibility Filtering for /list
// ============================================

function canSeeAgent(
  agent: AgentDefinition,
  auth: ResolvedAuth | null,
): boolean {
  const visibility: Visibility = agent.visibility ?? "internal";

  if (auth?.isRoot) return true;
  if (visibility === "public") return true;
  if (visibility === "internal" && auth) return true;
  return false;
}

// ============================================
// Create Server
// ============================================

/**
 * Create an HTTP server for the agent registry.
 *
 * @example
 * ```typescript
 * const registry = createAgentRegistry();
 * registry.register(createAuthAgent({ rootKey: 'rk_xxx' }));
 * registry.register(myAgent);
 *
 * const server = createAgentServer(registry, { port: 3000 });
 * await server.start();
 * // POST /call - Execute agent actions
 * // GET /list - List agents (filtered by auth)
 * // POST /oauth/token - OAuth2 token endpoint
 * ```
 */
export function createAgentServer(
  registry: AgentRegistry,
  options: AgentServerOptions = {},
): AgentServer {
  const {
    port = 3000,
    hostname = "localhost",
    basePath = "",
    cors = true,
    onNotFound,
  } = options;

  let serverInstance: ReturnType<typeof Bun.serve> | null = null;
  let serverUrl: string | null = null;

  // Detect auth configuration
  const authConfig = detectAuth(registry);

  /**
   * Handle incoming requests.
   */
  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(basePath, "") || "/";

    // Handle CORS preflight
    if (cors && req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Add CORS headers to response
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

    // Resolve auth on every request
    const auth = authConfig ? await resolveAuth(req, authConfig) : null;

    try {
      // POST /oauth/token - Standard OAuth2 endpoint
      if (path === "/oauth/token" && req.method === "POST" && authConfig) {
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
          return addCors(
            jsonResponse(
              {
                error: "unsupported_grant_type",
                error_description: "Only client_credentials is supported",
              },
              400,
            ),
          );
        }

        if (!clientId || !clientSecret) {
          return addCors(
            jsonResponse(
              {
                error: "invalid_request",
                error_description: "Missing client_id or client_secret",
              },
              400,
            ),
          );
        }

        const client = await authConfig.store.validateClient(
          clientId,
          clientSecret,
        );
        if (!client) {
          return addCors(
            jsonResponse(
              {
                error: "invalid_client",
                error_description: "Invalid client credentials",
              },
              401,
            ),
          );
        }

        // Generate token
        const tokenString = `at_${Array.from({ length: 48 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("")}`;
        const token = {
          token: tokenString,
          clientId: client.clientId,
          scopes: client.scopes,
          issuedAt: Date.now(),
          expiresAt: Date.now() + authConfig.tokenTtl * 1000,
        };
        await authConfig.store.storeToken(token);

        // Standard OAuth2 response
        return addCors(
          jsonResponse({
            access_token: token.token,
            token_type: "bearer",
            expires_in: authConfig.tokenTtl,
            scope: client.scopes.join(" "),
          }),
        );
      }

      // POST /call - Execute agent action
      if (path === "/call" && req.method === "POST") {
        const body = (await req.json()) as CallAgentRequest;

        if (!body.path || !body.action) {
          return addCors(
            jsonResponse(
              {
                success: false,
                error: "Missing required fields: path, action",
                code: "INVALID_REQUEST",
              },
              400,
            ),
          );
        }

        // Inject auth context into request
        if (auth) {
          body.callerId = auth.callerId;
          body.callerType = auth.callerType;
          if (!body.metadata) body.metadata = {};
          body.metadata.scopes = auth.scopes;
          body.metadata.isRoot = auth.isRoot;
        }

        // Root key bypasses all access checks
        if (auth?.isRoot) {
          body.callerType = "system";
        }

        const result = await registry.call(body);
        const status = "success" in result && result.success ? 200 : 400;
        return addCors(jsonResponse(result, status));
      }

      // GET /list - List agents (filtered by visibility)
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

      // Not found
      if (onNotFound) {
        return addCors(await onNotFound(req));
      }

      return addCors(
        jsonResponse(
          {
            success: false,
            error: `Not found: ${req.method} ${path}`,
            code: "NOT_FOUND",
          },
          404,
        ),
      );
    } catch (err) {
      return addCors(
        jsonResponse(
          {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            code: "INTERNAL_ERROR",
          },
          500,
        ),
      );
    }
  }

  const server: AgentServer = {
    async start(): Promise<void> {
      if (serverInstance) {
        throw new Error("Server is already running");
      }

      serverInstance = Bun.serve({
        port,
        hostname,
        fetch,
      });

      serverUrl = `http://${hostname}:${port}${basePath}`;
      console.log(`Agent server running at ${serverUrl}`);
      console.log(`  POST ${basePath}/call - Execute agent actions`);
      console.log(`  GET  ${basePath}/list - List agents`);
      if (authConfig) {
        console.log(`  POST ${basePath}/oauth/token - OAuth2 token endpoint`);
        console.log("  Auth: enabled (root key configured)");
      }
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
