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
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };

        let result: unknown;

        switch (body.method) {
          case "initialize":
            result = {
              protocolVersion: "2024-11-05",
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
    expect(existsSync(join(TEST_OUT_DIR, "search-pages.tool.ts"))).toBe(true);
    expect(existsSync(join(TEST_OUT_DIR, "create-page.tool.ts"))).toBe(true);
    expect(existsSync(join(TEST_OUT_DIR, "get-page.tool.ts"))).toBe(true);
  });

  test("generates agent.config.ts", () => {
    const content = readFileSync(
      join(TEST_OUT_DIR, "agent.config.ts"),
      "utf-8",
    );
    expect(content).toContain("defineAgent");
    expect(content).toContain("'@notion'");
    expect(content).toContain("searchPagesTool");
    expect(content).toContain("createPageTool");
    expect(content).toContain("getPageTool");
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

  test("generates index.ts with re-exports", () => {
    const content = readFileSync(join(TEST_OUT_DIR, "index.ts"), "utf-8");
    expect(content).toContain("searchPagesTool");
    expect(content).toContain("createPageTool");
    expect(content).toContain("getPageTool");
    expect(content).toContain("agent");
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

  test("tool files contain defineTool with correct schema", () => {
    const content = readFileSync(
      join(TEST_OUT_DIR, "search-pages.tool.ts"),
      "utf-8",
    );
    expect(content).toContain("defineTool");
    expect(content).toContain("'search_pages'");
    expect(content).toContain("Search for pages by query");
    expect(content).toContain("query");
    expect(content).toContain("limit");
  });

  test("tool files generate TypeScript interfaces", () => {
    const content = readFileSync(
      join(TEST_OUT_DIR, "search-pages.tool.ts"),
      "utf-8",
    );
    expect(content).toContain("export interface SearchPagesInput");
    expect(content).toContain("query: string");
    expect(content).toContain("limit?: number");
  });

  test("agent.config.ts imports from correct file paths", () => {
    const content = readFileSync(
      join(TEST_OUT_DIR, "agent.config.ts"),
      "utf-8",
    );
    expect(content).toContain("from './search-pages.tool.js'");
    expect(content).toContain("from './create-page.tool.js'");
    expect(content).toContain("from './get-page.tool.js'");
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
