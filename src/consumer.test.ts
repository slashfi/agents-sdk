import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createAgentRegistry,
  createAgentServer,
  createRegistryConsumer,
  defineAgent,
  defineTool,
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
  const PORT = 19892;

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

  test("discover registry via MCP initialize", async () => {
    const config = {
      registries: [`http://localhost:${PORT}`],
    };

    const consumer = await createRegistryConsumer(config);
    const discovery = await consumer.discover(`http://localhost:${PORT}`);

    expect(discovery).toBeDefined();
    expect(discovery.issuer).toBeDefined();
    expect(discovery.token_endpoint).toBe(
      `http://localhost:${PORT}/oauth/token`,
    );
  });

  test("list agents from registry", async () => {
    const config = {
      registries: [`http://localhost:${PORT}`],
      refs: [{ ref: "@math" }, { ref: "@echo" }],
    };

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
    const config = {
      registries: [`http://localhost:${PORT}`],
      refs: [
        { ref: "@math" },
        { ref: "@echo", as: "my-echo", config: { greeting: "hello" } },
      ],
    };

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
    const config = {
      registries: [`http://localhost:${PORT}`],
      refs: [{ ref: "@math" }],
    };

    const consumer = await createRegistryConsumer(config);
    const result = await consumer.call("@math", "add", { a: 2, b: 3 });

    expect(result).toBeDefined();
  });

  test("call throws on unknown ref", async () => {
    const config = {
      registries: [`http://localhost:${PORT}`],
      refs: [{ ref: "@math" }],
    };

    const consumer = await createRegistryConsumer(config);

    await expect(consumer.call("@nonexistent", "anything", {})).rejects.toThrow(
      'Ref "@nonexistent" not found',
    );
  });

  test("multi-instance refs with as: alias", async () => {
    const config = {
      registries: [`http://localhost:${PORT}`],
      refs: [
        { ref: "@echo", as: "echo-1", config: { prefix: "first" } },
        { ref: "@echo", as: "echo-2", config: { prefix: "second" } },
      ],
    };

    const consumer = await createRegistryConsumer(config);
    const refs = consumer.refs();

    expect(refs).toHaveLength(2);
    expect(refs[0].name).toBe("echo-1");
    expect(refs[0].ref).toBe("@echo");
    expect(refs[1].name).toBe("echo-2");
    expect(refs[1].ref).toBe("@echo");
  });

  test("index produces serialized config", async () => {
    const config = {
      registries: [`http://localhost:${PORT}`],
      refs: [{ ref: "@math" }, { ref: "@echo" }],
      meta: { owner: "test", description: "test config" },
    };

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
    const config = {
      registries: [`http://localhost:${PORT}`],
      refs: [{ ref: "@math" }],
    };

    const consumer = await createRegistryConsumer(config);
    const available = await consumer.available();

    // @math is configured, @echo should be available
    const paths = available.map((a) => a.path);
    expect(paths).not.toContain("@math");
    expect(paths).toContain("@echo");
  });

  test("registries returns normalized entries", async () => {
    const config = {
      registries: [
        `http://localhost:${PORT}`,
        { url: "https://twin.slash.com/tenants/test", publisher: "public" },
      ],
    };

    const consumer = await createRegistryConsumer(config);
    const registries = consumer.registries();

    expect(registries).toHaveLength(2);
    expect(registries[0].url).toBe(`http://localhost:${PORT}`);
    expect(registries[0].publisher).toBe("localhost");
    expect(registries[1].url).toBe("https://twin.slash.com/tenants/test");
    expect(registries[1].publisher).toBe("public");
  });
});

// ─── Unit: normalizeRef / normalizeRegistry ──────────────────────

import { isSecretUrl, normalizeRef, normalizeRegistry } from "./define-config";

describe("normalizeRef", () => {
  test("simple ref", () => {
    const result = normalizeRef({ ref: "notion" });
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
      publisher: "public",
      name: "Slash Private",
    });
    expect(result.publisher).toBe("public");
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

  test("rejects non-secret URIs", () => {
    expect(isSecretUrl("just-a-string")).toBe(false);
    expect(isSecretUrl(42)).toBe(false);
    expect(isSecretUrl(null)).toBe(false);
    expect(isSecretUrl("ftp://server/file")).toBe(false);
  });
});
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentRegistry,
  createAgentServer,
  createRegistryConsumer,
  defineAgent,
  defineTool,
  isSecretUri,
  isSecretUrl,
} from "./index";
import type { AgentServer, ConsumerConfig } from "./index";

describe("Secret URI resolution", () => {
  let tmpDir: string;
  let server: AgentServer;
  let authToken: string;
  const PORT = 19896;
  const BASE = `http://localhost:${PORT}`;

  beforeAll(async () => {
    // Create temp dir with secret files
    tmpDir = await mkdtemp(join(tmpdir(), "secrets-test-"));
    await writeFile(join(tmpDir, "notion-client-id"), "notion_cid_abc123");
    await writeFile(
      join(tmpDir, "notion-client-secret"),
      "notion_cs_secret456",
    );
    await writeFile(join(tmpDir, "api-key"), "sk-test-key-789");

    // Set env var for env:// test
    process.env.TEST_SECRET_VALUE = "env-secret-value";

    // Create a mock notion agent that echoes back received params
    const notionAgent = defineAgent({
      path: "notion",
      entrypoint: "Mock Notion agent",
      config: { name: "Notion", description: "Notion integration" },
      visibility: "public" as const,
      tools: [
        defineTool({
          name: "search_pages",
          description: "Search Notion pages",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              clientId: { type: "string" },
            },
            required: ["query"],
          },
          execute: async (input: { query: string; clientId?: string }) => ({
            results: [{ title: `Found: ${input.query}` }],
            authenticatedWith: input.clientId ?? "none",
          }),
        }),
      ],
    });

    const registry = createAgentRegistry();
    registry.register(notionAgent);

    server = createAgentServer(registry, { port: PORT });
    await server.initKeys();
    await server.start();

    authToken = await server.signJwt({ sub: "test-user" });
  });

  afterAll(async () => {
    await server?.stop?.();
    await rm(tmpDir, { recursive: true, force: true });
    process.env.TEST_SECRET_VALUE = undefined;
  });

  // ─── isSecretUri ───

  test("isSecretUri recognizes file:// URIs", () => {
    expect(isSecretUri("file:///tmp/secrets/key")).toBe(true);
  });

  test("isSecretUri recognizes env:// URIs", () => {
    expect(isSecretUri("env://MY_VAR")).toBe(true);
  });

  test("isSecretUri recognizes https:// URIs", () => {
    expect(isSecretUri("https://vault.example.com/secrets/key")).toBe(true);
  });

  test("isSecretUri rejects non-URI strings", () => {
    expect(isSecretUri("just-a-string")).toBe(false);
    expect(isSecretUri(42)).toBe(false);
    expect(isSecretUri(null)).toBe(false);
  });

  test("isSecretUrl is aliased to isSecretUri", () => {
    expect(isSecretUrl("file:///tmp/key")).toBe(true);
    expect(isSecretUrl("not-a-uri")).toBe(false);
  });

  // ─── file:// resolution ───

  test("resolveSecret handles file:// URIs", async () => {
    const consumer = await createRegistryConsumer(
      { registries: [BASE] },
      { token: authToken },
    );

    const value = await consumer.resolveSecret(
      `file://${join(tmpDir, "notion-client-id")}`,
    );
    expect(value).toBe("notion_cid_abc123");
  });

  // ─── env:// resolution ───

  test("resolveSecret handles env:// URIs", async () => {
    const consumer = await createRegistryConsumer(
      { registries: [BASE] },
      { token: authToken },
    );

    const value = await consumer.resolveSecret("env://TEST_SECRET_VALUE");
    expect(value).toBe("env-secret-value");
  });

  test("resolveSecret throws on missing env var", async () => {
    const consumer = await createRegistryConsumer(
      { registries: [BASE] },
      { token: authToken },
    );

    expect(consumer.resolveSecret("env://DOES_NOT_EXIST")).rejects.toThrow(
      "Environment variable not set",
    );
  });

  // ─── resolveConfig with file secrets ───

  test("resolveConfig resolves mixed URI schemes", async () => {
    const consumer = await createRegistryConsumer(
      { registries: [BASE] },
      { token: authToken },
    );

    const resolved = await consumer.resolveConfig({
      clientId: `file://${join(tmpDir, "notion-client-id")}`,
      clientSecret: `file://${join(tmpDir, "notion-client-secret")}`,
      apiKey: `file://${join(tmpDir, "api-key")}`,
      region: "us-east-1", // plain value, not a secret
    });

    expect(resolved.clientId).toBe("notion_cid_abc123");
    expect(resolved.clientSecret).toBe("notion_cs_secret456");
    expect(resolved.apiKey).toBe("sk-test-key-789");
    expect(resolved.region).toBe("us-east-1");
  });

  // ─── E2E: consumer config with agent URL + file secrets ───

  test("E2E: consumer config with agent URL and file:// secrets", async () => {
    // This is the pattern: ref points to agent URL, secrets in file://
    const config: ConsumerConfig = {
      refs: [
        {
          ref: "notion",
          url: `${BASE}/agents/notion`,
          config: {
            clientId: `file://${join(tmpDir, "notion-client-id")}`,
            clientSecret: `file://${join(tmpDir, "notion-client-secret")}`,
          },
        },
      ],
    };

    // Consumer resolves the config
    const consumer = await createRegistryConsumer(config, { token: authToken });

    // Resolve the ref's secrets
    const ref = config.refs?.[0];
    const refConfig = typeof ref === "string" ? {} : (ref.config ?? {});
    const resolved = await consumer.resolveConfig(refConfig);

    expect(resolved.clientId).toBe("notion_cid_abc123");
    expect(resolved.clientSecret).toBe("notion_cs_secret456");

    // Agent is discoverable at its URL
    const agentUrl = typeof ref === "string" ? ref : ref.url!;
    const infoRes = await fetch(agentUrl);
    expect(infoRes.status).toBe(200);
    const info = (await infoRes.json()) as { path: string; name: string };
    expect(info.name).toBe("Notion");

    // Call the agent with resolved secrets
    const callRes = await fetch(agentUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_pages",
          arguments: {
            query: "meeting notes",
            clientId: resolved.clientId,
          },
        },
      }),
    });
    expect(callRes.status).toBe(200);
    const data = (await callRes.json()) as { result: unknown };
    expect(data.result).toBeDefined();
  });

  // ─── unsupported scheme ───

  test("resolveSecret throws on unsupported scheme", async () => {
    const consumer = await createRegistryConsumer(
      { registries: [BASE] },
      { token: authToken },
    );

    expect(consumer.resolveSecret("ftp://some-server/secret")).rejects.toThrow(
      "Unsupported secret URI scheme",
    );
  });
});

// ─── API Key Auth Tests ──────────────────────────────────────────

describe("Registry Consumer — API Key Auth", () => {
  let server: AgentServer;
  const PORT = 19894;
  const API_KEY = "test-secret-key-12345";

  beforeAll(async () => {
    const registry = createAgentRegistry();
    registry.register(mathAgent);
    registry.register(echoAgent);

    server = createAgentServer(registry, {
      port: PORT,
      resolveAuth: async (req) => {
        const apiKey = req.headers.get("x-api-key");
        if (apiKey === API_KEY) {
          return {
            callerId: "api-key-user",
            callerType: "system" as const,
            scopes: ["*"],
          };
        }
        return null;
      },
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test("consumer with api-key auth type can list agents", async () => {
    const consumer = await createRegistryConsumer({
      registries: [
        {
          url: `http://localhost:${PORT}`,
          auth: { type: "api-key", key: API_KEY, header: "x-api-key" },
        },
      ],
      refs: [{ ref: "@math" }],
    });

    const agents = await consumer.list();
    expect(agents.length).toBeGreaterThanOrEqual(2);
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("@math");
    expect(paths).toContain("@echo");
  });

  test("consumer with custom headers can list agents", async () => {
    const consumer = await createRegistryConsumer({
      registries: [
        {
          url: `http://localhost:${PORT}`,
          headers: { "x-api-key": API_KEY },
        },
      ],
      refs: [{ ref: "@math" }],
    });

    const agents = await consumer.list();
    expect(agents.length).toBeGreaterThanOrEqual(2);
  });

  test("consumer with wrong api-key gets different auth context", async () => {
    // Without the right key, resolveAuth returns null (no auth context)
    // The server still processes the request but without auth identity
    const consumer = await createRegistryConsumer({
      registries: [
        {
          url: `http://localhost:${PORT}`,
          auth: { type: "api-key", key: "wrong-key", header: "x-api-key" },
        },
      ],
      refs: [{ ref: "@math" }],
    });

    // Can still list public agents (discovery doesn't require auth)
    const agents = await consumer.list();
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });

  test("consumer with api-key auth can call tools", async () => {
    const consumer = await createRegistryConsumer({
      registries: [
        {
          url: `http://localhost:${PORT}`,
          auth: { type: "api-key", key: API_KEY, header: "x-api-key" },
        },
      ],
      refs: [{ ref: "@math" }],
    });

    const result = await consumer.call("@math", "add", { a: 10, b: 20 });
    expect(result).toBeDefined();
  });

  test("inspect returns agent details via describe_tools", async () => {
    const consumer = await createRegistryConsumer({
      registries: [
        {
          url: `http://localhost:${PORT}`,
          auth: { type: "api-key", key: API_KEY, header: "x-api-key" },
        },
      ],
      refs: [{ ref: "@math" }],
    });

    const listing = await consumer.inspect("@math");
    expect(listing).not.toBeNull();
    expect(listing!.path).toBe("@math");
  });

  test("browse lists agents from a specific registry", async () => {
    const consumer = await createRegistryConsumer({
      registries: [
        {
          url: `http://localhost:${PORT}`,
          auth: { type: "api-key", key: API_KEY, header: "x-api-key" },
        },
      ],
      refs: [{ ref: "@math" }],
    });

    const agents = await consumer.browse(`http://localhost:${PORT}`);
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.some((a) => a.path === "@math")).toBe(true);
  });
});
