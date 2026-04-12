import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createAgentRegistry,
  createAgentServer,
  createAdk,
  defineAgent,
  defineTool,
} from "./index";
import type { AgentServer } from "./index";
import type { FsStore } from "./agent-definitions/config";

// ─── Helpers ─────────────────────────────────────────────────────

const echo = defineTool({
  name: "echo",
  description: "Echo back the input",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  execute: async (input: { message: string }) => ({ echoed: input.message }),
});

const add = defineTool({
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
});

const mathAgent = defineAgent({
  path: "@math",
  entrypoint: "A math agent",
  tools: [add],
  visibility: "public",
});

const echoAgent = defineAgent({
  path: "@echo",
  entrypoint: "An echo agent",
  tools: [echo],
  visibility: "public",
});

/** In-memory FsStore for testing */
function createMemoryFs(): FsStore {
  const files = new Map<string, string>();
  return {
    async readFile(path: string) {
      return files.get(path) ?? null;
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
  };
}

// ─── ADK Config Store: sourceRegistry routing ────────────────────

describe("ADK ref sourceRegistry routing", () => {
  let primaryServer: AgentServer;
  let sourceServer: AgentServer;
  const PRIMARY_PORT = 19900;
  const SOURCE_PORT = 19901;

  beforeAll(async () => {
    // Primary registry — only has @echo
    const primaryRegistry = createAgentRegistry();
    primaryRegistry.register(echoAgent);
    primaryServer = createAgentServer(primaryRegistry, { port: PRIMARY_PORT });
    await primaryServer.start();

    // Source registry — has @math (the one we want to route to)
    const sourceRegistry = createAgentRegistry();
    sourceRegistry.register(mathAgent);
    sourceServer = createAgentServer(sourceRegistry, { port: SOURCE_PORT });
    await sourceServer.start();
  });

  afterAll(async () => {
    await primaryServer.stop();
    await sourceServer.stop();
  });

  test("ref.call routes through sourceRegistry, not first registry", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    // Add primary registry (only has @echo, NOT @math)
    await adk.registry.add({
      url: `http://localhost:${PRIMARY_PORT}`,
      name: "primary",
    });

    // Add ref with sourceRegistry pointing to the source server (which has @math)
    await adk.ref.add({
      ref: "@math",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${SOURCE_PORT}`,
        agentPath: "@math",
      },
    });

    // Call should route to source server, not primary
    const result = await adk.ref.call("@math", "add", { a: 10, b: 20 });
    expect(result).toBeDefined();
  });

  test("ref.inspect routes through sourceRegistry", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    // Add primary registry (doesn't have @math)
    await adk.registry.add({
      url: `http://localhost:${PRIMARY_PORT}`,
      name: "primary",
    });

    // Seed the ref directly to bypass add-time validation
    // (we're testing inspect routing, not add validation)
    const config = JSON.parse((await fs.readFile("consumer-config.json"))!);
    config.refs = [
      {
        ref: "@math",
        scheme: "registry",
        sourceRegistry: {
          url: `http://localhost:${SOURCE_PORT}`,
          agentPath: "@math",
        },
      },
    ];
    await fs.writeFile("consumer-config.json", JSON.stringify(config));

    // Inspect should find the agent on the source server
    const info = await adk.ref.inspect("@math");
    expect(info).toBeDefined();
    const toolCount = (info?.tools?.length ?? 0) + (info?.toolSummaries?.length ?? 0);
    expect(toolCount).toBeGreaterThan(0);
  });
});

// ─── ADK Config Store: ref.add validation ────────────────────────

describe("ADK ref.add validation", () => {
  test("throws when no scheme specified", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await expect(
      adk.ref.add({ ref: "@something" }),
    ).rejects.toThrow("could not determine connection type");
  });

  test("throws when scheme is 'registry' without sourceRegistry", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await expect(
      adk.ref.add({ ref: "@something", scheme: "registry" }),
    ).rejects.toThrow("requires a source registry");
  });

  test("throws when scheme is 'mcp' without url", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await expect(
      adk.ref.add({ ref: "@something", scheme: "mcp" }),
    ).rejects.toThrow("requires url");
  });

  test("throws when scheme is 'https' without url", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await expect(
      adk.ref.add({ ref: "@something", scheme: "https" }),
    ).rejects.toThrow("requires url");
  });

  test("allows scheme 'registry' with sourceRegistry", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    // sourceRegistry + scheme: registry — should pass validation
    // (may fail at inspect time if unreachable, but that's fine)
    try {
      await adk.ref.add({
        ref: "@something",
        scheme: "registry",
        sourceRegistry: {
          url: "http://localhost:59999",
          agentPath: "@something",
        },
      });
    } catch (e: any) {
      // REF_NOT_FOUND or REGISTRY_UNREACHABLE are fine
      // REF_INVALID would mean our validation is wrong
      expect(e.code).not.toBe("REF_INVALID");
    }
  });

  test("allows scheme 'mcp' with url", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    const result = await adk.ref.add({
      ref: "@direct",
      url: "http://localhost:59999",
      scheme: "mcp",
    });
    expect(result).toBeDefined();
  });

  test("allows scheme 'https' with url", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    const result = await adk.ref.add({
      ref: "@direct-https",
      url: "http://localhost:59999",
      scheme: "https",
    });
    expect(result).toBeDefined();
  });
});
