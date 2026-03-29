/**
 * Tests for MCP Codegen
 *
 * Tests the codegen pipeline using a mock MCP server that responds
 * via HTTP JSON-RPC.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { codegen, useAgent, listAgentTools } from "./codegen.js";
import type { McpToolDefinition } from "./codegen.js";

// ============================================
// Mock MCP Server
// ============================================

const MOCK_TOOLS: McpToolDefinition[] = [
  {
    name: "search_pages",
    description: "Search for pages by query",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_page",
    description: "Create a new page",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Page title" },
        content: { type: "string", description: "Page content" },
        parent_id: { type: "string", description: "Parent page ID" },
      },
      required: ["title"],
    },
  },
  {
    name: "get_page",
    description: "Get a page by ID",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "Page ID" },
      },
      required: ["page_id"],
    },
  },
];

let mockServer: ReturnType<typeof Bun.serve>;
let mockPort: number;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      return (async () => {
        const body = (await req.json()) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };

        // Handle notifications (no id) — return 202 Accepted
        if (body.id === undefined) {
          return new Response(null, { status: 202 });
        }

        let result: unknown;

        switch (body.method) {
          case "initialize":
            result = {
              protocolVersion: "2025-03-26",
              serverInfo: {
                name: "mock-notion",
                version: "1.0.0",
              },
              capabilities: { tools: {} },
            };
            break;

          case "notifications/initialized":
            result = {};
            break;

          case "tools/list":
            result = { tools: MOCK_TOOLS };
            break;

          case "tools/call": {
            const params = body.params as {
              name: string;
              arguments: Record<string, unknown>;
            };
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    tool: params.name,
                    args: params.arguments,
                    mock: true,
                  }),
                },
              ],
            };
            break;
          }

          default:
            return Response.json(
              {
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32601, message: `Unknown method: ${body.method}` },
              },
              { status: 200 },
            );
        }

        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result,
        });
      })();
    },
  });
  mockPort = mockServer.port;
});

afterAll(() => {
  mockServer.stop();
});

// ============================================
// Tests
// ============================================

const TEST_OUT_DIR = "/tmp/agents-sdk-codegen-test";

describe("codegen", () => {
  beforeAll(async () => {
    // Clean up previous test output
    rmSync(TEST_OUT_DIR, { recursive: true, force: true });

    await codegen({
      server: `http://localhost:${mockPort}`,
      outDir: TEST_OUT_DIR,
      name: "notion",
      agentPath: "@notion",
    });
  });

  afterAll(() => {
    rmSync(TEST_OUT_DIR, { recursive: true, force: true });
  });

  test("generates tool files for each MCP tool", () => {
    expect(existsSync(join(TEST_OUT_DIR, "search-pages.tool.md"))).toBe(true);
    expect(existsSync(join(TEST_OUT_DIR, "create-page.tool.md"))).toBe(true);
    expect(existsSync(join(TEST_OUT_DIR, "get-page.tool.md"))).toBe(true);
  });

  test("generates agent.config.ts", () => {
    const content = readFileSync(
      join(TEST_OUT_DIR, "agent.config.ts"),
      "utf-8",
    );
    expect(content).toContain("defineAgent");
    expect(content).toContain("'@notion'");
  });

  test("generates entrypoint.md", () => {
    const content = readFileSync(
      join(TEST_OUT_DIR, "entrypoint.md"),
      "utf-8",
    );
    expect(content).toContain("# mock-notion");
    expect(content).toContain("search_pages");
    expect(content).toContain("create_page");
    expect(content).toContain("get_page");
  });

  test("generates index.ts with agent export", () => {
    const content = readFileSync(join(TEST_OUT_DIR, "index.ts"), "utf-8");
    expect(content).toContain("agent.config");
  });

  test("generates cli.ts", () => {
    const content = readFileSync(join(TEST_OUT_DIR, "cli.ts"), "utf-8");
    expect(content).toContain("search_pages");
    expect(content).toContain("--list");
    expect(content).toContain("--help");
  });

  test("generates .codegen-manifest.json", () => {
    const content = readFileSync(
      join(TEST_OUT_DIR, ".codegen-manifest.json"),
      "utf-8",
    );
    const manifest = JSON.parse(content);
    expect(manifest.agentPath).toBe("@notion");
    expect(manifest.serverInfo.name).toBe("mock-notion");
    expect(manifest.tools).toHaveLength(3);
    expect(manifest.tools[0].name).toBe("search_pages");
  });

  test("tool files contain markdown with parameters", () => {
    const content = readFileSync(
      join(TEST_OUT_DIR, "search-pages.tool.md"),
      "utf-8",
    );
    expect(content).toContain("# search_pages");
    expect(content).toContain("Search for pages by query");
    expect(content).toContain("| query");
    expect(content).toContain("| limit");
    expect(content).toContain("## Parameters");
  });

  test("tool files include type and required info", () => {
    const content = readFileSync(
      join(TEST_OUT_DIR, "search-pages.tool.md"),
      "utf-8",
    );
    expect(content).toContain("`string`");
    expect(content).toContain("✓"); // required marker for query
  });

  test("agent.config.ts has defineAgent", () => {
    const content = readFileSync(
      join(TEST_OUT_DIR, "agent.config.ts"),
      "utf-8",
    );
    expect(content).toContain("defineAgent");
    expect(content).toContain("entrypoint");
  });
});

describe("listAgentTools", () => {
  beforeAll(async () => {
    rmSync(TEST_OUT_DIR, { recursive: true, force: true });
    await codegen({
      server: `http://localhost:${mockPort}`,
      outDir: TEST_OUT_DIR,
      name: "notion",
    });
  });

  afterAll(() => {
    rmSync(TEST_OUT_DIR, { recursive: true, force: true });
  });

  test("lists tools from manifest", () => {
    const tools = listAgentTools(TEST_OUT_DIR);
    expect(tools).toHaveLength(3);
    expect(tools[0].name).toBe("search_pages");
    expect(tools[1].name).toBe("create_page");
    expect(tools[2].name).toBe("get_page");
  });
});

describe("codegen JSON Schema support", () => {
  const SCHEMA_OUT_DIR = "/tmp/agents-sdk-codegen-schema-test";
  let schemaServer: ReturnType<typeof Bun.serve>;
  let schemaPort: number;

  const COMPLEX_TOOLS: McpToolDefinition[] = [
    {
      name: "complex_tool",
      description: "Tool with advanced JSON Schema features",
      inputSchema: {
        type: "object",
        properties: {
          status: { enum: ["open", "closed", "pending"] },
          value: { oneOf: [{ type: "string" }, { type: "number" }] },
          merged: { allOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "number" } } }] },
          flexible: { anyOf: [{ type: "string" }, { type: "null" }] },
          literal: { const: "fixed_value" },
          excluded: { not: { type: "string" } },
          email: { type: "string", format: "email" },
          age: { type: "integer" },
          nullable: { type: ["string", "null"] },
          tags: { type: "array", items: { type: "string" } },
          metadata: { type: "object", additionalProperties: { type: "string" } },
          coords: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] },
        },
        required: ["status", "value"],
      },
    },
  ];

  beforeAll(async () => {
    rmSync(SCHEMA_OUT_DIR, { recursive: true, force: true });

    schemaServer = Bun.serve({
      port: 0,
      fetch(req) {
        return (async () => {
          const body = (await req.json()) as { id?: number; method: string; params?: Record<string, unknown> };
          if (body.id === undefined) return new Response(null, { status: 202 });

          let result: unknown;
          switch (body.method) {
            case "initialize":
              result = { protocolVersion: "2025-03-26", serverInfo: { name: "schema-test", version: "1.0.0" }, capabilities: { tools: {} } };
              break;
            case "tools/list":
              result = { tools: COMPLEX_TOOLS };
              break;
            default:
              return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Unknown: ${body.method}` } });
          }
          return Response.json({ jsonrpc: "2.0", id: body.id, result });
        })();
      },
    });
    schemaPort = schemaServer.port;

    await codegen({
      server: `http://localhost:${schemaPort}`,
      outDir: SCHEMA_OUT_DIR,
      name: "schema-test",
    });
  });

  afterAll(() => {
    schemaServer.stop();
    rmSync(SCHEMA_OUT_DIR, { recursive: true, force: true });
  });

  test("renders enum as union", () => {
    const content = readFileSync(join(SCHEMA_OUT_DIR, "complex-tool.tool.md"), "utf-8");
    expect(content).toContain('"open" | "closed" | "pending"');
  });

  test("renders oneOf as union", () => {
    const content = readFileSync(join(SCHEMA_OUT_DIR, "complex-tool.tool.md"), "utf-8");
    expect(content).toContain("string | number");
  });

  test("renders allOf as intersection", () => {
    const content = readFileSync(join(SCHEMA_OUT_DIR, "complex-tool.tool.md"), "utf-8");
    expect(content).toContain("&");
  });

  test("renders const as literal", () => {
    const content = readFileSync(join(SCHEMA_OUT_DIR, "complex-tool.tool.md"), "utf-8");
    expect(content).toContain('"fixed_value"');
  });

  test("renders not", () => {
    const content = readFileSync(join(SCHEMA_OUT_DIR, "complex-tool.tool.md"), "utf-8");
    expect(content).toContain("Exclude");
  });

  test("renders format hint", () => {
    const content = readFileSync(join(SCHEMA_OUT_DIR, "complex-tool.tool.md"), "utf-8");
    expect(content).toContain("email");
  });

  test("renders integer as number", () => {
    const content = readFileSync(join(SCHEMA_OUT_DIR, "complex-tool.tool.md"), "utf-8");
    expect(content).toContain("integer");
  });

  test("renders nullable type array", () => {
    const content = readFileSync(join(SCHEMA_OUT_DIR, "complex-tool.tool.md"), "utf-8");
    expect(content).toContain("string | null");
  });

  test("renders additionalProperties as Record", () => {
    const content = readFileSync(join(SCHEMA_OUT_DIR, "complex-tool.tool.md"), "utf-8");
    expect(content).toContain("Record<string, string>");
  });

  test("renders tuple arrays", () => {
    const content = readFileSync(join(SCHEMA_OUT_DIR, "complex-tool.tool.md"), "utf-8");
    expect(content).toContain("[number, number]");
  });
});

describe("codegen pagination", () => {
  const PAGINATED_OUT_DIR = "/tmp/agents-sdk-codegen-paginated-test";
  let paginatedServer: ReturnType<typeof Bun.serve>;
  let paginatedPort: number;

  beforeAll(async () => {
    rmSync(PAGINATED_OUT_DIR, { recursive: true, force: true });

    // Mock server that paginates tools across 2 pages
    paginatedServer = Bun.serve({
      port: 0,
      fetch(req) {
        return (async () => {
          const body = (await req.json()) as {
            id?: number;
            method: string;
            params?: Record<string, unknown>;
          };

          if (body.id === undefined) {
            return new Response(null, { status: 202 });
          }

          let result: unknown;

          switch (body.method) {
            case "initialize":
              result = {
                protocolVersion: "2025-03-26",
                serverInfo: { name: "paginated-server", version: "1.0.0" },
                capabilities: { tools: {} },
              };
              break;

            case "tools/list": {
              const cursor = (body.params as { cursor?: string })?.cursor;
              if (!cursor) {
                // Page 1: return first 2 tools + nextCursor
                result = {
                  tools: [MOCK_TOOLS[0], MOCK_TOOLS[1]],
                  nextCursor: "page2",
                };
              } else {
                // Page 2: return last tool, no nextCursor
                result = {
                  tools: [MOCK_TOOLS[2]],
                };
              }
              break;
            }

            default:
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: body.id,
                  error: { code: -32601, message: `Unknown: ${body.method}` },
                },
                { status: 200 },
              );
          }

          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result,
          });
        })();
      },
    });
    paginatedPort = paginatedServer.port;

    await codegen({
      server: `http://localhost:${paginatedPort}`,
      outDir: PAGINATED_OUT_DIR,
      name: "paginated",
    });
  });

  afterAll(() => {
    paginatedServer.stop();
    rmSync(PAGINATED_OUT_DIR, { recursive: true, force: true });
  });

  test("collects all tools across paginated responses", () => {
    // All 3 tools should be present despite being split across 2 pages
    expect(existsSync(join(PAGINATED_OUT_DIR, "search-pages.tool.md"))).toBe(true);
    expect(existsSync(join(PAGINATED_OUT_DIR, "create-page.tool.md"))).toBe(true);
    expect(existsSync(join(PAGINATED_OUT_DIR, "get-page.tool.md"))).toBe(true);
  });

  test("manifest contains all paginated tools", () => {
    const manifest = JSON.parse(
      readFileSync(join(PAGINATED_OUT_DIR, ".codegen-manifest.json"), "utf-8"),
    );
    expect(manifest.tools.length).toBe(3);
  });
});

describe("useAgent", () => {
  beforeAll(async () => {
    rmSync(TEST_OUT_DIR, { recursive: true, force: true });
    await codegen({
      server: `http://localhost:${mockPort}`,
      outDir: TEST_OUT_DIR,
      name: "notion",
    });
  });

  afterAll(() => {
    rmSync(TEST_OUT_DIR, { recursive: true, force: true });
  });

  test("executes a tool via MCP server", async () => {
    const result = (await useAgent({
      agentDir: TEST_OUT_DIR,
      tool: "search_pages",
      params: { query: "hello" },
    })) as { content: { type: string; text: string }[] };

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tool).toBe("search_pages");
    expect(parsed.args.query).toBe("hello");
    expect(parsed.mock).toBe(true);
  });

  test("rejects unknown tool", async () => {
    await expect(
      useAgent({
        agentDir: TEST_OUT_DIR,
        tool: "nonexistent_tool",
      }),
    ).rejects.toThrow("Unknown tool");
  });
});
