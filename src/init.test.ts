/**
 * Tests for init + materialize modules.
 *
 * Focuses on:
 * - parseTarget parsing (preset-based)
 * - Skill template generation
 * - Type generation from tool schemas
 * - Materialization file structure
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseTarget, runInit, loadPresets, getPreset, renderContent } from "./init.js";
import type { SkillTarget, Preset } from "./init.js";
import { materializeRef } from "./materialize.js";
import type { Adk } from "./config-store.js";
import { createAdk } from "./config-store.js";
import type { FsStore } from "./agent-definitions/config.js";

// ============================================
// Helpers
// ============================================

const TEST_DIR = join(import.meta.dir, "../.test-output");

function createMemoryStore(): FsStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path: string) {
      return files.get(path) ?? null;
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
  };
}

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

// ============================================
// Presets
// ============================================

describe("presets", () => {
  test("loads all preset files", () => {
    const presets = loadPresets();
    expect(presets.size).toBeGreaterThanOrEqual(4);
    expect(presets.has("claude")).toBe(true);
    expect(presets.has("cursor")).toBe(true);
    expect(presets.has("copilot")).toBe(true);
    expect(presets.has("windsurf")).toBe(true);
  });

  test("claude preset writes SKILL.md", () => {
    const preset = getPreset("claude");
    expect(preset).toBeDefined();
    expect(preset!.filename).toContain("SKILL.md");
  });

  test("cursor preset targets .agents/skills", () => {
    const preset = getPreset("cursor");
    expect(preset).toBeDefined();
    expect(preset!.defaultPath).toBe(".agents/skills");
  });

  test("copilot preset targets .github/skills", () => {
    const preset = getPreset("copilot");
    expect(preset).toBeDefined();
    expect(preset!.defaultPath).toBe(".github/skills");
  });
});

// ============================================
// parseTarget
// ============================================

describe("parseTarget", () => {
  test("parses preset name with default path", () => {
    const result = parseTarget("claude");
    expect(result.preset.name).toBe("claude");
    expect(result.path).toContain(".claude/skills");
  });

  test("parses preset:path override", () => {
    const result = parseTarget("cursor:/tmp/my-rules");
    expect(result.preset.name).toBe("cursor");
    expect(result.path).toBe("/tmp/my-rules");
  });

  test("parses all preset names", () => {
    for (const name of ["claude", "cursor", "copilot", "windsurf"]) {
      const result = parseTarget(name);
      expect(result.preset.name).toBe(name);
    }
  });

  test("parses preset with custom path", () => {
    const result = parseTarget("claude:/tmp/custom");
    expect(result.preset.name).toBe("claude");
    expect(result.path).toBe("/tmp/custom");
  });

  test("throws on unknown target", () => {
    expect(() => parseTarget("unknown")).toThrow("Unknown preset");
  });

  test("throws on unknown with path", () => {
    expect(() => parseTarget("vscode:/tmp")).toThrow("Unknown target");
  });
});

// ============================================
// renderContent
// ============================================

describe("renderContent", () => {
  const body = "Test content";
  const meta = { name: "test", description: "Test desc" };

  test("includes YAML frontmatter with name and description", () => {
    const result = renderContent(body, meta);
    expect(result).toContain("---");
    expect(result).toContain("name: test");
    expect(result).toContain("description: Test desc");
    expect(result).toContain("Test content");
  });
});

// ============================================
// runInit
// ============================================

describe("runInit", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("writes claude skill file to target path", async () => {
    const store = createMemoryStore();
    const adk = createAdk(store);
    const skillDir = join(TEST_DIR, "claude-skills");
    const preset = getPreset("claude")!;

    await runInit(adk, [{ preset, path: skillDir }]);

    const skillPath = join(skillDir, preset.filename);
    expect(existsSync(skillPath)).toBe(true);

    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("name: adk");
    expect(content).toContain("description:");
    expect(content).toContain("adk ref call");
  });

  test("writes cursor skill file to target path", async () => {
    const store = createMemoryStore();
    const adk = createAdk(store);
    const skillDir = join(TEST_DIR, "cursor-skills");
    const preset = getPreset("cursor")!;

    await runInit(adk, [{ preset, path: skillDir }]);

    const skillPath = join(skillDir, preset.filename);
    expect(existsSync(skillPath)).toBe(true);

    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("name: adk");
    expect(content).toContain("adk ref call");
  });

  test("saves targets to config", async () => {
    const store = createMemoryStore();
    const adk = createAdk(store);
    const skillDir = join(TEST_DIR, "save-test");
    const preset = getPreset("claude")!;

    await runInit(adk, [{ preset, path: skillDir }]);

    const configRaw = store.files.get("consumer-config.json");
    expect(configRaw).toBeDefined();
    const config = JSON.parse(configRaw!);
    expect(config.targets).toBeDefined();
  });

  test("adds default registry on first run", async () => {
    const store = createMemoryStore();
    const adk = createAdk(store);

    await runInit(adk, []);

    const configRaw = store.files.get("consumer-config.json");
    expect(configRaw).toBeDefined();
    const config = JSON.parse(configRaw!);
    expect(config.registries).toBeDefined();
    expect(config.registries.some((r: any) => r.url === "https://registry.slash.com")).toBe(true);
  });

  test("is idempotent with default registry", async () => {
    const store = createMemoryStore();
    const adk = createAdk(store);

    await runInit(adk, []);
    await runInit(adk, []);

    const config = JSON.parse(store.files.get("consumer-config.json")!);
    const slashRegistries = config.registries.filter((r: any) => r.url === "https://registry.slash.com");
    expect(slashRegistries.length).toBe(1);
  });
});

// ============================================
// Type Generation (via materializeRef)
// ============================================

describe("type generation", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("generates valid .d.ts from tool schemas", async () => {
    const configDir = join(TEST_DIR, "types-test");

    const mockTools = [
      {
        name: "search_pages",
        description: "Search for Notion pages",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
        },
      },
      {
        name: "create_page",
        description: "Create a new page in a database",
        inputSchema: {
          type: "object",
          properties: {
            parent_id: { type: "string" },
            title: { type: "string" },
          },
          required: ["parent_id", "title"],
        },
      },
      {
        name: "API-get-block",
        description: "Get a block by ID",
        inputSchema: {
          type: "object",
          properties: {
            block_id: { type: "string" },
          },
          required: ["block_id"],
        },
      },
    ];

    const adk = {
      ref: {
        inspect: async () => ({
          path: "notion",
          description: "Notion MCP agent",
          tools: mockTools,
        }),
        resources: async () => ({ result: { resources: [] } }),
      },
      readConfig: async () => ({}),
      writeConfig: async () => {},
    } as unknown as Adk;

    const result = await materializeRef(adk, "notion", configDir);

    expect(result.toolCount).toBe(3);
    expect(result.typesGenerated).toBe(true);

    // Check .d.ts file
    const dtsPath = join(configDir, "refs", "notion", "types", "notion.d.ts");
    expect(existsSync(dtsPath)).toBe(true);

    const dts = readFileSync(dtsPath, "utf-8");
    expect(dts).toContain("export interface NotionTools");
    expect(dts).toContain('"search_pages"');
    expect(dts).toContain('"create_page"');
    expect(dts).toContain('"API-get-block"');
    expect(dts).toContain("Search for Notion pages");
    expect(dts).toContain("Create a new page in a database");
    expect(dts).toContain("export declare const tools");
  });

  test("generates tool.json files per tool", async () => {
    const configDir = join(TEST_DIR, "tool-json-test");

    const mockTools = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ];

    const adk = {
      ref: {
        inspect: async () => ({ tools: mockTools }),
        resources: async () => ({ result: { resources: [] } }),
      },
    } as unknown as Adk;

    const result = await materializeRef(adk, "test-agent", configDir);

    expect(result.toolCount).toBe(1);

    const toolPath = join(configDir, "refs", "test-agent", "tools", "search.tool.json");
    expect(existsSync(toolPath)).toBe(true);

    const tool = JSON.parse(readFileSync(toolPath, "utf-8"));
    expect(tool.name).toBe("search");
    expect(tool.description).toBe("Search");
    expect(tool.inputSchema.properties.q.type).toBe("string");
  });

  test("generates agent.json metadata", async () => {
    const configDir = join(TEST_DIR, "agent-json-test");

    const adk = {
      ref: {
        inspect: async () => ({
          description: "Test agent",
          tools: [{ name: "tool1", description: "A tool" }],
        }),
        resources: async () => ({ result: { resources: [] } }),
      },
    } as unknown as Adk;

    await materializeRef(adk, "myagent", configDir);

    const metaPath = join(configDir, "refs", "myagent", "agent.json");
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.name).toBe("myagent");
    expect(meta.description).toBe("Test agent");
    expect(meta.toolCount).toBe(1);
    expect(meta.tools).toEqual(["tool1"]);
    expect(meta.materializedAt).toBeDefined();
  });

  test("handles special characters in tool names", async () => {
    const configDir = join(TEST_DIR, "special-chars-test");

    const adk = {
      ref: {
        inspect: async () => ({
          tools: [
            { name: "API-post-search/v2", description: "Search v2" },
            { name: "get:users.list", description: "List users" },
          ],
        }),
        resources: async () => ({ result: { resources: [] } }),
      },
    } as unknown as Adk;

    const result = await materializeRef(adk, "test", configDir);
    expect(result.toolCount).toBe(2);

    // Check filenames are sanitized
    const toolsDir = join(configDir, "refs", "test", "tools");
    expect(existsSync(join(toolsDir, "API-post-search_v2.tool.json"))).toBe(true);
    expect(existsSync(join(toolsDir, "get_users_list.tool.json"))).toBe(true);

    // Check .d.ts handles them
    const dts = readFileSync(join(configDir, "refs", "test", "types", "test.d.ts"), "utf-8");
    expect(dts).toContain('"API-post-search/v2"');
    expect(dts).toContain('"get:users.list"');
  });

  test("handles inspect failure gracefully", async () => {
    const configDir = join(TEST_DIR, "fail-test");

    const adk = {
      ref: {
        inspect: async () => { throw new Error("Not authenticated"); },
        resources: async () => { throw new Error("Not authenticated"); },
      },
    } as unknown as Adk;

    const result = await materializeRef(adk, "failing", configDir);
    expect(result.toolCount).toBe(0);
    expect(result.skillCount).toBe(0);
    expect(result.typesGenerated).toBe(false);
  });

  test("pascalCase conversion works for type name", async () => {
    const configDir = join(TEST_DIR, "pascal-test");

    const adk = {
      ref: {
        inspect: async () => ({
          tools: [{ name: "test", description: "Test" }],
        }),
        resources: async () => ({ result: { resources: [] } }),
      },
    } as unknown as Adk;

    await materializeRef(adk, "my-cool-agent", configDir);

    const dts = readFileSync(
      join(configDir, "refs", "my-cool-agent", "types", "my-cool-agent.d.ts"),
      "utf-8",
    );
    expect(dts).toContain("export interface MyCoolAgentTools");
  });
});
