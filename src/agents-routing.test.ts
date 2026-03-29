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
  path: "@internal",
  entrypoint: "Internal system agent",
  tools: [
    defineTool({
      name: "whoami",
      description: "Who am I",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ user: "admin" }),
    }),
  ],
});

// Internal with explicit visibility
const secretsAgent = defineAgent({
  path: "@secrets",
  entrypoint: "Secrets agent",
  visibility: "internal",
  tools: [
    defineTool({
      name: "get_secret",
      description: "Get a secret",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      execute: async () => ({ value: "s3cr3t" }),
    }),
  ],
});

// ─── Tests ─────────────────────────────────────────────────────

describe("/agents routing", () => {
  let server: AgentServer;
  let authToken: string;
  const PORT = 19895;
  const BASE = `http://localhost:${PORT}`;

  beforeAll(async () => {
    const registry = createAgentRegistry();
    registry.register(notionAgent);
    registry.register(linearAgent);
    registry.register(internalAgent);
    registry.register(secretsAgent);

    server = createAgentServer(registry, { port: PORT });
    await server.initKeys();
    await server.start();

    // Get an auth token for authenticated tests
    authToken = await server.signJwt({
      sub: "test-user",
      email: "test@example.com",
    });
  });

  afterAll(async () => {
    await server?.stop?.();
  });

  function authHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    };
  }

  // ─── Discovery (no auth needed) ───────────────────────────

  test("GET /agents lists only agents with explicit visibility (no auth)", async () => {
    const res = await fetch(`${BASE}/agents`);
    expect(res.status).toBe(200);
    const agents = (await res.json()) as { path: string }[];
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("notion");
    expect(paths).toContain("linear");
    expect(paths).not.toContain("@internal"); // no visibility = not listed
    expect(paths).not.toContain("@secrets"); // internal visibility = needs auth
  });

  test("GET /agents with auth shows internal agents too", async () => {
    const res = await fetch(`${BASE}/agents`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const agents = (await res.json()) as { path: string }[];
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("notion");
    expect(paths).toContain("linear");
    expect(paths).toContain("@secrets"); // internal visible with auth
    expect(paths).not.toContain("@internal"); // still hidden (no visibility set)
  });

  test("GET /agents/notion returns tool info (no auth)", async () => {
    const res = await fetch(`${BASE}/agents/notion`);
    expect(res.status).toBe(200);
    const agent = (await res.json()) as {
      path: string;
      name: string;
      tools: { name: string; inputSchema: unknown }[];
    };
    expect(agent.path).toBe("notion");
    expect(agent.name).toBe("Notion");
    expect(agent.tools.map((t) => t.name)).toContain("search_pages");
    expect(agent.tools.map((t) => t.name)).toContain("api");
    // Full schemas on single-agent endpoint
    expect(agent.tools.find((t) => t.name === "search_pages")!.inputSchema).toBeDefined();
  });

  test("GET /agents/unknown returns 404", async () => {
    const res = await fetch(`${BASE}/agents/unknown`);
    expect(res.status).toBe(404);
  });

  test("GET /agents/@secrets without auth returns 404", async () => {
    const res = await fetch(`${BASE}/agents/@secrets`);
    expect(res.status).toBe(404); // canSeeAgent returns false
  });

  test("GET /agents/@secrets with auth returns agent info", async () => {
    const res = await fetch(`${BASE}/agents/@secrets`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const agent = (await res.json()) as { path: string };
    expect(agent.path).toBe("@secrets");
  });

  // ─── tools/list (still discovery, no auth needed) ───────

  test("POST /agents/notion tools/list works without auth", async () => {
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

  // ─── tools/call (auth required) ────────────────────────

  test("POST /agents/notion tools/call WITHOUT auth returns 401", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_pages", arguments: { query: "test" } },
      }),
    });
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: { message: string } };
    expect(data.error.message).toContain("Authentication required");
  });

  test("POST /agents/notion tools/call WITH auth succeeds", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_pages", arguments: { query: "meeting notes" } },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: unknown };
    expect(data.result).toBeDefined();
  });

  test("POST /agents/notion api proxy tool WITH auth", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
      method: "POST",
      headers: authHeaders(),
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

  test("POST /agents/linear tools/call WITH auth", async () => {
    const res = await fetch(`${BASE}/agents/linear`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_issues", arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
  });

  // ─── initialize ───────────────────────────────────────

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
    const data = (await res.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(data.result.serverInfo.name).toBe("Notion");
  });

  // ─── Legacy ───────────────────────────────────────────

  test("GET /list still works (legacy)", async () => {
    const res = await fetch(`${BASE}/list`);
    expect(res.status).toBe(200);
    const agents = (await res.json()) as { path: string }[];
    expect(agents.length).toBeGreaterThanOrEqual(2);
  });
});
