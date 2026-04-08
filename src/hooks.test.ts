/**
 * Tests for tools/call/call_agent and tools/call/list_agents hooks.
 *
 * These go through the full production path:
 *   HTTP POST → JSON-RPC → MCP tools/call → handleToolCall → registry hooks
 *
 * Mirrors how atlas-os uses these hooks to intercept and route requests.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createAgentRegistry,
  createAgentServer,
  defineAgent,
  defineTool,
} from "./index";
import type {
  AgentDefinition,
  AgentServer,
  CallAgentToolCallEvent,
  ListAgentsToolCallEvent,
} from "./index";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test agents
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const echoAgent = defineAgent({
  path: "@echo",
  entrypoint: "Echo agent",
  config: { name: "Echo", description: "Echoes input back" },
  visibility: "public" as const,
  tools: [
    defineTool({
      name: "echo",
      description: "Echo the input",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      execute: async (input: { message: string }) => ({
        echoed: input.message,
      }),
    }),
  ],
});

const mathAgent = defineAgent({
  path: "@math",
  entrypoint: "Math agent",
  config: { name: "Math", description: "Does math" },
  visibility: "public" as const,
  tools: [
    defineTool({
      name: "add",
      description: "Add two numbers",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      },
      execute: async (input: { a: number; b: number }) => ({
        result: input.a + input.b,
      }),
    }),
  ],
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Helper: MCP JSON-RPC call through HTTP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let nextId = 1;
async function mcpCall(
  baseUrl: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  const json = (await res.json()) as {
    result?: { content?: Array<{ text: string }> };
  };
  const text = json.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : json;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// tools/call/call_agent tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("tools/call/call_agent hook", () => {
  const PORT = 19870;

  test("resolve() short-circuits the default handler", async () => {
    // This mirrors atlas-os: intercept call_agent, route externally, resolve()
    const registry = createAgentRegistry({ defaultVisibility: "public" });
    registry.register(echoAgent);

    registry.on("tools/call/call_agent", async (event) => {
      event.resolve({
        success: true,
        result: { intercepted: true, originalPath: event.request.path },
      });
    });

    const server = createAgentServer(registry, { port: PORT });
    await server.start();

    const result = await mcpCall(`http://localhost:${PORT}`, "call_agent", {
      action: "execute_tool",
      path: "@echo",
      tool: "echo",
      params: { message: "hello" },
    });

    expect(result.success).toBe(true);
    expect(result.result.intercepted).toBe(true);
    expect(result.result.originalPath).toBe("@echo");
    await server.stop();
  });

  test("next() runs default handler and hook observes", async () => {
    const registry = createAgentRegistry({ defaultVisibility: "public" });
    registry.register(echoAgent);

    let hookSawRequest = false;
    registry.on("tools/call/call_agent", async (event) => {
      hookSawRequest = true;
      await event.next();
    });

    const server = createAgentServer(registry, { port: PORT + 1 });
    await server.start();

    const result = await mcpCall(`http://localhost:${PORT + 1}`, "call_agent", {
      action: "execute_tool",
      path: "@echo",
      tool: "echo",
      params: { message: "passthrough" },
    });

    expect(hookSawRequest).toBe(true);
    expect(result.success).toBe(true);
    expect(result.result.echoed).toBe("passthrough");
    await server.stop();
  });

  test("next() with modified request reroutes the call", async () => {
    const registry = createAgentRegistry({ defaultVisibility: "public" });
    registry.register(echoAgent);
    registry.register(mathAgent);

    registry.on("tools/call/call_agent", async (event) => {
      if (event.request.action === "execute_tool" && event.request.path === "@echo") {
        await event.next({
          ...event.request,
          path: "@math",
          tool: "add",
          params: { a: 10, b: 20 },
        });
      }
    });

    const server = createAgentServer(registry, { port: PORT + 2 });
    await server.start();

    const result = await mcpCall(`http://localhost:${PORT + 2}`, "call_agent", {
      action: "execute_tool",
      path: "@echo",
      tool: "echo",
      params: { message: "this gets rerouted" },
    });

    expect(result.success).toBe(true);
    expect(result.result.result).toBe(30);
    await server.stop();
  });

  test("no listener = default behavior unchanged", async () => {
    const registry = createAgentRegistry({ defaultVisibility: "public" });
    registry.register(echoAgent);

    const server = createAgentServer(registry, { port: PORT + 3 });
    await server.start();

    const result = await mcpCall(`http://localhost:${PORT + 3}`, "call_agent", {
      action: "execute_tool",
      path: "@echo",
      tool: "echo",
      params: { message: "no hook" },
    });

    expect(result.success).toBe(true);
    expect(result.result.echoed).toBe("no hook");
    await server.stop();
  });

  test("resolve() with error response", async () => {
    const registry = createAgentRegistry({ defaultVisibility: "public" });
    registry.register(echoAgent);

    registry.on("tools/call/call_agent", async (event) => {
      event.resolve({
        success: false,
        error: "Agent not available in remote registry",
        code: "AGENT_NOT_FOUND",
      });
    });

    const server = createAgentServer(registry, { port: PORT + 4 });
    await server.start();

    const result = await mcpCall(`http://localhost:${PORT + 4}`, "call_agent", {
      action: "execute_tool",
      path: "@nonexistent",
      tool: "foo",
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Agent not available in remote registry");
    await server.stop();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// tools/call/list_agents tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("tools/call/list_agents hook", () => {
  const PORT = 19880;

  test("next() with additional agents merges into listing", async () => {
    const registry = createAgentRegistry({ defaultVisibility: "public" });
    registry.register(echoAgent);

    const remoteAgent = defineAgent({
      path: "@remote-db",
      entrypoint: "Remote database agent",
      config: { name: "RemoteDB", description: "Query remote databases" },
      visibility: "public" as const,
      tools: [
        defineTool({
          name: "query",
          description: "Run a SQL query",
          inputSchema: { type: "object", properties: { sql: { type: "string" } } },
          execute: async () => ({ rows: [] }),
        }),
      ],
    });

    registry.on("tools/call/list_agents", async (event) => {
      await event.next([remoteAgent]);
    });

    const server = createAgentServer(registry, { port: PORT });
    await server.start();

    const result = await mcpCall(`http://localhost:${PORT}`, "list_agents", {});

    expect(result.success).toBe(true);
    const paths = result.agents.map((a: { path: string }) => a.path);
    expect(paths).toContain("@echo");
    expect(paths).toContain("@remote-db");
    expect(result.total).toBe(2);
    await server.stop();
  });

  test("injected agents appear in BM25 search results", async () => {
    const registry = createAgentRegistry({ defaultVisibility: "public" });
    registry.register(echoAgent);

    const remoteAgent = defineAgent({
      path: "@snowflake",
      entrypoint: "Snowflake analytics",
      config: { name: "Snowflake", description: "Analytics data warehouse queries" },
      visibility: "public" as const,
      tools: [
        defineTool({
          name: "run_query",
          description: "Run an analytics query on Snowflake",
          inputSchema: { type: "object", properties: { sql: { type: "string" } } },
          execute: async () => ({ rows: [] }),
        }),
      ],
    });

    registry.on("tools/call/list_agents", async (event) => {
      await event.next([remoteAgent]);
    });

    const server = createAgentServer(registry, { port: PORT + 1 });
    await server.start();

    const result = await mcpCall(`http://localhost:${PORT + 1}`, "list_agents", {
      query: "analytics warehouse",
    });

    expect(result.success).toBe(true);
    const paths = result.agents.map((a: { path: string }) => a.path);
    expect(paths).toContain("@snowflake");
    await server.stop();
  });

  test("resolve() fully replaces the response", async () => {
    const registry = createAgentRegistry({ defaultVisibility: "public" });
    registry.register(echoAgent);
    registry.register(mathAgent);

    registry.on("tools/call/list_agents", async (event) => {
      event.resolve({
        success: true,
        total: 1,
        agents: [
          {
            path: "@custom-only",
            name: "Custom",
            description: "Only this one",
            tools: ["do_stuff"],
          },
        ],
      });
    });

    const server = createAgentServer(registry, { port: PORT + 2 });
    await server.start();

    const result = await mcpCall(`http://localhost:${PORT + 2}`, "list_agents", {});

    expect(result.success).toBe(true);
    expect(result.agents.length).toBe(1);
    expect(result.agents[0].path).toBe("@custom-only");
    const paths = result.agents.map((a: { path: string }) => a.path);
    expect(paths).not.toContain("@echo");
    expect(paths).not.toContain("@math");
    await server.stop();
  });

  test("no listener = default behavior unchanged", async () => {
    const registry = createAgentRegistry({ defaultVisibility: "public" });
    registry.register(echoAgent);
    registry.register(mathAgent);

    const server = createAgentServer(registry, { port: PORT + 3 });
    await server.start();

    const result = await mcpCall(`http://localhost:${PORT + 3}`, "list_agents", {});

    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
    const paths = result.agents.map((a: { path: string }) => a.path);
    expect(paths).toContain("@echo");
    expect(paths).toContain("@math");
    await server.stop();
  });

  test("deduplicates by path — injected agent overrides local", async () => {
    const registry = createAgentRegistry({ defaultVisibility: "public" });
    registry.register(echoAgent);

    const overrideEcho = defineAgent({
      path: "@echo",
      entrypoint: "Overridden echo",
      config: { name: "Echo Override", description: "This replaced the original" },
      visibility: "public" as const,
      tools: [
        defineTool({
          name: "echo",
          description: "Overridden echo tool",
          inputSchema: { type: "object", properties: { message: { type: "string" } } },
          execute: async () => ({ overridden: true }),
        }),
      ],
    });

    registry.on("tools/call/list_agents", async (event) => {
      await event.next([overrideEcho]);
    });

    const server = createAgentServer(registry, { port: PORT + 4 });
    await server.start();

    const result = await mcpCall(`http://localhost:${PORT + 4}`, "list_agents", {});

    expect(result.success).toBe(true);
    expect(result.total).toBe(1);
    expect(result.agents[0].description).toBe("This replaced the original");
    await server.stop();
  });

  test("event carries query/limit/cursor params", async () => {
    const registry = createAgentRegistry({ defaultVisibility: "public" });
    registry.register(echoAgent);

    let capturedEvent: {
      query?: string;
      limit?: number;
      cursor?: string;
      baseAgentCount: number;
    } | null = null;

    registry.on("tools/call/list_agents", async (event) => {
      capturedEvent = {
        query: event.query,
        limit: event.limit,
        cursor: event.cursor,
        baseAgentCount: event.baseAgents.length,
      };
    });

    const server = createAgentServer(registry, { port: PORT + 5 });
    await server.start();

    await mcpCall(`http://localhost:${PORT + 5}`, "list_agents", {
      query: "echo",
      limit: 5,
    });

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent!.query).toBe("echo");
    expect(capturedEvent!.limit).toBe(5);
    expect(capturedEvent!.baseAgentCount).toBe(1);
    await server.stop();
  });
});
