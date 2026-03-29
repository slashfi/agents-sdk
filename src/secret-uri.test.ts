import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentServer,
  createAgentRegistry,
  defineAgent,
  defineTool,
  createRegistryConsumer,
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
    await writeFile(join(tmpDir, "notion-client-secret"), "notion_cs_secret456");
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
    delete process.env.TEST_SECRET_VALUE;
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

    expect(
      consumer.resolveSecret("env://DOES_NOT_EXIST"),
    ).rejects.toThrow("Environment variable not set");
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
    const consumer = await createRegistryConsumer(
      config,
      { token: authToken },
    );

    // Resolve the ref's secrets
    const ref = config.refs![0];
    const refConfig = typeof ref === "string" ? {} : ref.config ?? {};
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

    expect(
      consumer.resolveSecret("ftp://some-server/secret"),
    ).rejects.toThrow("Unsupported secret URI scheme");
  });
});
