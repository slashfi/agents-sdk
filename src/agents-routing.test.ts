import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createAgentServer,
  createAgentRegistry,
  createAuthAgent,
  defineAgent,
  defineTool,
} from "./index";
import type { AgentServer } from "./index";

// ─── Agents ──────────────────────────────────────────────────────

const notionAgent = defineAgent({
  path: "notion",
  entrypoint: "Notion integration agent",
  config: { name: "Notion", description: "Connect to Notion workspaces" },
  visibility: "public",
  tools: [
    defineTool({
      name: "search_pages",
      description: "Search for pages in Notion",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
      execute: async (input: { query: string }) => ({
        results: [{ title: `Result for: ${input.query}`, id: "page-123" }],
      }),
    }),
    defineTool({
      name: "api",
      description: "Make a raw API call to Notion",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] },
          path: { type: "string", description: "API path (e.g. /v1/pages)" },
          body: { type: "object", description: "Request body" },
        },
        required: ["method", "path"],
      },
      execute: async (input: { method: string; path: string; body?: unknown }) => ({
        status: 200,
        data: { mock: true, method: input.method, path: input.path },
      }),
    }),
  ],
});

const linearAgent = defineAgent({
  path: "linear",
  entrypoint: "Linear integration agent",
  config: { name: "Linear", description: "Connect to Linear workspaces" },
  visibility: "public",
  tools: [
    defineTool({
      name: "list_issues",
      description: "List issues from Linear",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ issues: [{ id: "LIN-1", title: "Fix bug" }] }),
    }),
    defineTool({
      name: "api",
      description: "Make a raw GraphQL call to Linear",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "GraphQL query" },
          variables: { type: "object", description: "Variables" },
        },
        required: ["query"],
      },
      execute: async (input: { query: string }) => ({
        data: { mock: true, query: input.query },
      }),
    }),
  ],
});

// Internal agent (no visibility) — should NOT appear under /agents
const internalAgent = defineAgent({
  path: "@auth",
  entrypoint: "Internal auth agent",
  tools: [
    defineTool({
      name: "whoami",
      description: "Who am I",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ user: "admin" }),
    }),
  ],
});

// ─── Tests ─────────────────────────────────────────────────────

describe("/agents routing", () => {
  let server: AgentServer;
  const PORT = 19895;
  const BASE = `http://localhost:${PORT}`;

  beforeAll(async () => {
    const registry = createAgentRegistry();
    registry.register(notionAgent);
    registry.register(linearAgent);
    registry.register(internalAgent);

    server = createAgentServer(registry, { port: PORT });
    await server.initKeys();
    await server.start();
  });

  afterAll(async () => {
    await server?.stop?.();
  });

  // ── Discovery ──

  test("GET /agents lists only agents with explicit visibility", async () => {
    const res = await fetch(`${BASE}/agents`);
    expect(res.status).toBe(200);
    const agents = (await res.json()) as { path: string }[];
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("notion");
    expect(paths).toContain("linear");
    expect(paths).not.toContain("@auth"); // no visibility = not discoverable
  });

  test("GET /agents returns tool info for each agent", async () => {
    const res = await fetch(`${BASE}/agents`);
    const agents = (await res.json()) as { path: string; tools: { name: string }[] }[];
    const notion = agents.find((a) => a.path === "notion")!;
    expect(notion.tools.map((t) => t.name)).toContain("search_pages");
    expect(notion.tools.map((t) => t.name)).toContain("api");
  });

  // ── Single agent info ──

  test("GET /agents/notion returns agent info with full schemas", async () => {
    const res = await fetch(`${BASE}/agents/notion`);
    expect(res.status).toBe(200);
    const agent = (await res.json()) as { path: string; name: string; tools: { name: string; inputSchema: unknown }[] };
    expect(agent.path).toBe("notion");
    expect(agent.name).toBe("Notion");
    expect(agent.tools.length).toBeGreaterThanOrEqual(2);
    // Full schemas on single-agent endpoint
    const searchTool = agent.tools.find((t) => t.name === "search_pages")!;
    expect(searchTool.inputSchema).toBeDefined();
  });

  test("GET /agents/unknown returns 404", async () => {
    const res = await fetch(`${BASE}/agents/unknown`);
    expect(res.status).toBe(404);
  });

  // ── Scoped MCP calls ──

  test("POST /agents/notion tools/list returns only notion tools", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    const data = (await res.json()) as { result: { tools: { name: string }[] } };
    const toolNames = data.result.tools.map((t) => t.name);
    expect(toolNames).toContain("search_pages");
    expect(toolNames).toContain("api");
    expect(toolNames).not.toContain("list_issues"); // linear tool
  });

  test("POST /agents/notion tools/call executes tool", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_pages",
          arguments: { query: "meeting notes" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: unknown };
    expect(data.result).toBeDefined();
  });

  test("POST /agents/notion initialize returns agent-scoped server info", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    const data = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(data.result.serverInfo.name).toBe("Notion");
  });

  test("POST /agents/linear tools/call executes linear tool", async () => {
    const res = await fetch(`${BASE}/agents/linear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "list_issues",
          arguments: {},
        },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: unknown };
    expect(data.result).toBeDefined();
  });

  test("POST /agents/notion tools/call with api proxy tool", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "api",
          arguments: { method: "GET", path: "/v1/pages/page-123" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: unknown };
    expect(data.result).toBeDefined();
  });

  // ── Legacy /list still works ──

  test("GET /list still works (legacy)", async () => {
    const res = await fetch(`${BASE}/list`);
    expect(res.status).toBe(200);
    const agents = (await res.json()) as { path: string }[];
    // Legacy list shows all agents (including internal ones)
    expect(agents.length).toBeGreaterThanOrEqual(2);
  });
});
