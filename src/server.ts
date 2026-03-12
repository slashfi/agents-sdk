/**
 * Agent Server
 *
 * HTTP server that exposes the agent registry via JSON-RPC endpoints.
 * Compatible with MCP (Model Context Protocol) over HTTP.
 *
 * Endpoints:
 * - POST /call - Execute agent actions (execute_tool, describe_tools, load)
 * - GET /list - List registered agents
 */

import type { AgentRegistry } from "./registry.js";
import type { CallAgentRequest } from "./types.js";

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
// Create Server
// ============================================

/**
 * Create an HTTP server for the agent registry.
 *
 * @example
 * ```typescript
 * const registry = createAgentRegistry();
 * registry.register(myAgent);
 *
 * const server = createAgentServer(registry, { port: 3000 });
 * await server.start();
 * // Server running at http://localhost:3000
 * // POST /call - Execute agent actions
 * // GET /list - List agents
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

    try {
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

        const result = await registry.call(body);
        return addCors(jsonResponse(result));
      }

      // GET /list - List agents
      if (path === "/list" && req.method === "GET") {
        const agents = registry.list();
        return addCors(
          jsonResponse({
            success: true,
            agents: agents.map((agent) => ({
              path: agent.path,
              name: agent.config?.name,
              description: agent.config?.description,
              supportedActions: agent.config?.supportedActions,
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
