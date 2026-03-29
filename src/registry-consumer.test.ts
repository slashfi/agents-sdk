import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createAgentServer,
  createAgentRegistry,
  defineAgent,
  defineTool,
  createRegistryConsumer,
} from "./index";
import type { AgentServer } from "./index";

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

// ─── E2E: Registry Consumer ──────────────────────────────────────

describe("Registry Consumer E2E", () => {
  let server: AgentServer;
  const PORT = 19890;

  beforeAll(async () => {
    const registry = createAgentRegistry();
    registry.register(mathAgent);
    registry.register(echoAgent);

    server = createAgentServer(registry, { port: PORT });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test("well-known configuration does not leak agent paths", async () => {
    const res = await fetch(`http://localhost:${PORT}/.well-known/configuration`);
    const config = await res.json();

    // Should have server metadata
    expect(config.issuer).toBeDefined();
    expect(config.jwks_uri).toBeDefined();
    expect(config.agents_endpoint).toBeDefined();
    expect(config.call_endpoint).toBeDefined();

    // Should NOT have agent paths
    expect(config.agents).toBeUndefined();
  });

  test("discover registry via .well-known/configuration", async () => {
    const config = ({
      registries: [`http://localhost:${PORT}`],
    });

    const consumer = await createRegistryConsumer(config);
    const discovery = await consumer.discover(`http://localhost:${PORT}`);

    expect(discovery).toBeDefined();
    expect(discovery.issuer).toBeDefined();
  });

  test("list agents from registry", async () => {
    const config = ({
      registries: [`http://localhost:${PORT}`],
      refs: ["@math", "@echo"],
    });

    const consumer = await createRegistryConsumer(config);
    const agents = await consumer.list();

    expect(agents.length).toBeGreaterThanOrEqual(2);

    const paths = agents.map((a) => a.path);
    expect(paths).toContain("@math");
    expect(paths).toContain("@echo");

    // Every agent should have the publisher from the registry
    for (const agent of agents) {
      expect(agent.publisher).toBe("localhost");
    }
  });

  test("refs returns configured refs", async () => {
    const config = ({
      registries: [`http://localhost:${PORT}`],
      refs: [
        "@math",
        { ref: "@echo", as: "my-echo", config: { greeting: "hello" } },
      ],
    });

    const consumer = await createRegistryConsumer(config);
    const refs = consumer.refs();

    expect(refs).toHaveLength(2);
    expect(refs[0].name).toBe("@math");
    expect(refs[0].ref).toBe("@math");
    expect(refs[1].name).toBe("my-echo");
    expect(refs[1].ref).toBe("@echo");
    expect(refs[1].config).toEqual({ greeting: "hello" });
  });

  test("call a tool on a ref", async () => {
    const config = ({
      registries: [`http://localhost:${PORT}`],
      refs: ["@math"],
    });

    const consumer = await createRegistryConsumer(config);
    const result = await consumer.call("@math", "add", { a: 2, b: 3 });

    expect(result).toBeDefined();
  });

  test("call throws on unknown ref", async () => {
    const config = ({
      registries: [`http://localhost:${PORT}`],
      refs: ["@math"],
    });

    const consumer = await createRegistryConsumer(config);

    await expect(
      consumer.call("@nonexistent", "anything", {}),
    ).rejects.toThrow('Ref "@nonexistent" not found');
  });

  test("multi-instance refs with as: alias", async () => {
    const config = ({
      registries: [`http://localhost:${PORT}`],
      refs: [
        { ref: "@echo", as: "echo-1", config: { prefix: "first" } },
        { ref: "@echo", as: "echo-2", config: { prefix: "second" } },
      ],
    });

    const consumer = await createRegistryConsumer(config);
    const refs = consumer.refs();

    expect(refs).toHaveLength(2);
    expect(refs[0].name).toBe("echo-1");
    expect(refs[0].ref).toBe("@echo");
    expect(refs[1].name).toBe("echo-2");
    expect(refs[1].ref).toBe("@echo");
  });

  test("index produces serialized config", async () => {
    const config = ({
      registries: [`http://localhost:${PORT}`],
      refs: ["@math", "@echo"],
      meta: { owner: "test", description: "test config" },
    });

    const consumer = await createRegistryConsumer(config);
    const indexed = consumer.index();

    expect(indexed.resolvedAt).toBeDefined();
    expect(indexed.sourceHash).toBeDefined();
    expect(indexed.registries).toHaveLength(1);
    expect(indexed.refs).toHaveLength(2);
    expect(indexed.meta?.owner).toBe("test");

    // Should be JSON-serializable
    const json = JSON.stringify(indexed);
    const parsed = JSON.parse(json);
    expect(parsed.refs).toHaveLength(2);
  });

  test("available returns agents not in config", async () => {
    const config = ({
      registries: [`http://localhost:${PORT}`],
      refs: ["@math"],
    });

    const consumer = await createRegistryConsumer(config);
    const available = await consumer.available();

    // @math is configured, @echo should be available
    const paths = available.map((a) => a.path);
    expect(paths).not.toContain("@math");
    expect(paths).toContain("@echo");
  });

  test("registries returns normalized entries", async () => {
    const config = ({
      registries: [
        `http://localhost:${PORT}`,
        { url: "https://twin.slash.com/tenants/test", publisher: "slash" },
      ],
    });

    const consumer = await createRegistryConsumer(config);
    const registries = consumer.registries();

    expect(registries).toHaveLength(2);
    expect(registries[0].url).toBe(`http://localhost:${PORT}`);
    expect(registries[0].publisher).toBe("localhost");
    expect(registries[1].url).toBe("https://twin.slash.com/tenants/test");
    expect(registries[1].publisher).toBe("slash");
  });
});



// ─── Unit: normalizeRef / normalizeRegistry ──────────────────────

import { normalizeRef, normalizeRegistry, isSecretUrl } from "./define-config";

describe("normalizeRef", () => {
  test("string ref", () => {
    const result = normalizeRef("notion");
    expect(result).toEqual({
      ref: "notion",
      name: "notion",
      config: {},
    });
  });

  test("object ref with alias", () => {
    const result = normalizeRef({
      ref: "postgres",
      as: "prod-db",
      config: { url: "https://twin.slash.com/secrets/db" },
    });
    expect(result.ref).toBe("postgres");
    expect(result.name).toBe("prod-db");
    expect(result.config).toEqual({
      url: "https://twin.slash.com/secrets/db",
    });
  });

  test("object ref without alias uses ref as name", () => {
    const result = normalizeRef({ ref: "github" });
    expect(result.name).toBe("github");
  });
});

describe("normalizeRegistry", () => {
  test("string URL", () => {
    const result = normalizeRegistry("https://registry.slash.com");
    expect(result.url).toBe("https://registry.slash.com");
    expect(result.name).toBe("registry.slash.com");
    expect(result.publisher).toBe("registry");
    expect(result.auth).toEqual({ type: "none" });
  });

  test("object with custom publisher", () => {
    const result = normalizeRegistry({
      url: "https://twin.slash.com",
      publisher: "slash",
      name: "Slash Private",
    });
    expect(result.publisher).toBe("slash");
    expect(result.name).toBe("Slash Private");
  });

  test("object with auth", () => {
    const result = normalizeRegistry({
      url: "https://twin.slash.com",
      auth: { type: "bearer", token: "test" },
    });
    expect(result.auth).toEqual({ type: "bearer", token: "test" });
  });
});

describe("isSecretUrl", () => {
  test("detects secret URLs", () => {
    expect(
      isSecretUrl("https://twin.slash.com/users/abc/secrets/notion-key"),
    ).toBe(true);
    expect(
      isSecretUrl("https://twin.slash.com/tenants/slash/secrets/db-url"),
    ).toBe(true);
  });

  test("rejects non-secret URLs", () => {
    expect(isSecretUrl("https://twin.slash.com/tenants/slash")).toBe(false);
    expect(isSecretUrl("just-a-string")).toBe(false);
    expect(isSecretUrl(42)).toBe(false);
    expect(isSecretUrl(null)).toBe(false);
  });
});
