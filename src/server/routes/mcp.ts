/**
 * MCP JSON-RPC route.
 *
 * POST / → MCP JSON-RPC endpoint (Streamable HTTP transport)
 *   Methods: initialize, notifications/initialized, ping, tools/list, tools/call
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { processSecretParams } from "../../agent-definitions/secrets.js";
import { type BM25Document, createBM25Index } from "../../bm25.js";
import { callAgentInputSchema } from "../../call-agent-schema.js";
import type { CallAgentRequest } from "../../types.js";
import { canSeeAgent, hasAdminScope } from "../auth.js";
import { jsonRpcError, jsonRpcSuccess, mcpResult } from "../helpers.js";
import type { HonoEnv, JsonRpcRequest, JsonRpcResponse, ResolvedAuth, ServerContext } from "../types.js";

// ── Tool Definitions ──
function getToolDefinitions() {
  return [
    {
      name: "call_agent",
      description:
        "Execute a tool on a registered agent. Provide the agent path and tool name.",
      inputSchema: callAgentInputSchema,
    },
    {
      name: "list_agents",
      description: "List all registered agents and their available tools.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "search_agent_tools",
      description:
        "Search across all registered agent tools using natural language. Returns tools ranked by relevance using BM25 scoring.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural language search query (e.g. 'send a message', 'database query')",
          },
          agents: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of agent paths to search within (e.g. ['@notifications', '@db']). Searches all agents if omitted.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default: 10)",
          },
        },
        required: ["query"],
      },
    },
  ];
}

// ── Route Registration ──

export function registerMcpRoutes(app: OpenAPIHono<HonoEnv>, ctx: ServerContext) {
  const { registry, options, secretStore } = ctx;
  const serverName = options.serverName ?? "agents-sdk";
  const serverVersion = options.serverVersion ?? "1.0.0";

  const mcpRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["MCP"],
    summary: "MCP JSON-RPC endpoint (Streamable HTTP transport)",
    description:
      "Handles all MCP protocol methods via JSON-RPC 2.0: initialize, notifications/initialized, ping, tools/list, tools/call. Supports batch requests.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.union([
              z.object({
                jsonrpc: z.literal("2.0").optional(),
                id: z.union([z.string(), z.number()]).optional(),
                method: z.string().openapi({ example: "tools/list" }),
                params: z.record(z.unknown()).optional(),
              }),
              z.array(
                z.object({
                  jsonrpc: z.literal("2.0").optional(),
                  id: z.union([z.string(), z.number()]).optional(),
                  method: z.string(),
                  params: z.record(z.unknown()).optional(),
                }),
              ),
            ]),
          },
        },
      },
    },
    responses: {
      200: {
        description: "JSON-RPC response (single or batch)",
        content: {
          "application/json": {
            schema: z.object({
              jsonrpc: z.literal("2.0"),
              id: z.union([z.string(), z.number(), z.null()]),
              result: z.unknown().optional(),
              error: z
                .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
                .optional(),
            }),
          },
        },
      },
      202: { description: "Accepted (for notifications)" },
    },
  });

  // POST / → MCP JSON-RPC
  app.openapi(mcpRoute, async (c): Promise<any> => {
    const auth = c.get("auth");
    const body = await c.req.json();

    // Batch requests
    if (Array.isArray(body)) {
      const results = await Promise.all(
        body.map((req: any) => handleJsonRpc(req, auth)),
      );
      const responses = results.filter((r: any) => r !== null);
      if (responses.length === 0) return c.body(null, 202);
      return c.json(responses);
    }

    // Notifications (no id)
    if (!body.id && body.method?.startsWith("notifications/")) {
      return c.body(null, 202);
    }

    // Ping
    if (body.method === "ping") {
      return c.json(jsonRpcSuccess(body.id, {}));
    }

    const result = await handleJsonRpc(body, auth);
    return c.json(result);
  });

  // ── JSON-RPC dispatcher (inner function) ──
  async function handleJsonRpc(
    request: JsonRpcRequest,
    auth: ResolvedAuth | null,
  ): Promise<JsonRpcResponse> {
    switch (request.method) {
      case "initialize":
        return jsonRpcSuccess(request.id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: { listChanged: false },
            ...(options.registry && {
              registry: {
                version: options.registry.version ?? "1.0",
                ...(options.registry.features && { features: options.registry.features }),
                ...(options.registry.oauthCallbackUrl && { oauthCallbackUrl: options.registry.oauthCallbackUrl }),
              },
            }),
          },
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

  // ── Tool call handler (inner function) ──
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
          if (auth.issuer) req.metadata.issuer = auth.issuer;
        }
        if (hasAdminScope(auth)) {
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
                if (hasAdminScope(auth)) return true;
                if (tv === "public") return true;
                if (
                  tv === "authenticated" &&
                  auth?.callerId &&
                  auth.callerId !== "anonymous"
                )
                  return true;
                if (tv === "internal" && auth) return true;
                return false;
              })
              .map((t) => t.name),
          })),
        });
      }

      case "search_agent_tools": {
        const { query, agents: agentFilter, limit: resultLimit } = args as {
          query: string;
          agents?: string[];
          limit?: number;
        };

        const agents = registry.list();
        const visible = agents.filter((agent) => {
          if (!canSeeAgent(agent, auth)) return false;
          if (agentFilter && agentFilter.length > 0) {
            return agentFilter.includes(agent.path);
          }
          return true;
        });

        // Build search documents from all visible tools
        const documents: (BM25Document & {
          agentPath: string;
          toolName: string;
          description: string;
          agentName?: string;
          agentDescription?: string;
        })[] = [];

        for (const agent of visible) {
          const visibleTools = agent.tools.filter((t) => {
            const tv = t.visibility ?? "internal";
            if (hasAdminScope(auth)) return true;
            if (tv === "public") return true;
            if (
              tv === "authenticated" &&
              auth?.callerId &&
              auth.callerId !== "anonymous"
            )
              return true;
            if (tv === "internal" && auth) return true;
            return false;
          });

          for (const tool of visibleTools) {
            // Build searchable text from tool name, description, agent context, and schema
            const parts = [
              tool.name,
              tool.description,
              agent.config?.name ?? "",
              agent.config?.description ?? "",
              agent.path,
            ];

            // Include property names and descriptions from input schema
            const schema = tool.inputSchema as any;
            if (schema?.properties) {
              for (const [key, prop] of Object.entries(schema.properties)) {
                parts.push(key);
                if ((prop as any)?.description) {
                  parts.push((prop as any).description);
                }
              }
            }

            documents.push({
              id: `${agent.path}/${tool.name}`,
              text: parts.join(" "),
              agentPath: agent.path,
              toolName: tool.name,
              description: tool.description,
              agentName: agent.config?.name,
              agentDescription: agent.config?.description,
            });
          }
        }

        const index = createBM25Index(documents);
        const results = index.search(query, resultLimit ?? 10);

        // Map results back to tool details
        const docMap = new Map(documents.map((d) => [d.id, d]));
        const matches = results.map((r) => {
          const doc = docMap.get(r.id)!;
          return {
            agentPath: doc.agentPath,
            tool: doc.toolName,
            description: doc.description,
            agentName: doc.agentName,
            agentDescription: doc.agentDescription,
            score: r.score,
          };
        });

        return mcpResult({
          success: true,
          query,
          results: matches,
          total: matches.length,
        });
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}
