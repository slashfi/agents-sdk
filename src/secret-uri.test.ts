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
} from "./index";
import type { AgentServer } from "./index";

// ─── Tests ─────────────────────────────────────────────────────

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

    // Create a simple agent that echoes back the resolved secrets
    const echoAgent = defineAgent({
      path: "echo",
      entrypoint: "Echo agent for testing secret resolution",
      visibility: "public" as const,
      tools: [
        defineTool({
          name: "echo_secrets",
          description: "Echoes back provided params",
          inputSchema: {
            type: "object",
            properties: {
              clientId: { type: "string" },
              clientSecret: { type: "string" },
              apiKey: { type: "string" },
            },
          },
          execute: async (input: Record<string, string>) => ({
            received: input,
          }),
        }),
      ],
    });

    const registry = createAgentRegistry();
    registry.register(echoAgent);

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

  test("isSecretUri rejects plain strings", () => {
    expect(isSecretUri("just-a-string")).toBe(false);
    expect(isSecretUri(42)).toBe(false);
    expect(isSecretUri(null)).toBe(false);
  });

  // ─── file:// resolution ───

  test("consumer resolves file:// secrets", async () => {
    const consumer = await createRegistryConsumer(
      {
        registries: [BASE],
      },
      { token: authToken },
    );

    const clientId = await consumer.resolveSecret(
      `file://${join(tmpDir, "notion-client-id")}`,
    );
    expect(clientId).toBe("notion_cid_abc123");

    const clientSecret = await consumer.resolveSecret(
      `file://${join(tmpDir, "notion-client-secret")}`,
    );
    expect(clientSecret).toBe("notion_cs_secret456");
  });

  // ─── env:// resolution ───

  test("consumer resolves env:// secrets", async () => {
    const consumer = await createRegistryConsumer(
      { registries: [BASE] },
      { token: authToken },
    );

    const value = await consumer.resolveSecret("env://TEST_SECRET_VALUE");
    expect(value).toBe("env-secret-value");
  });

  test("consumer throws on missing env:// secret", async () => {
    const consumer = await createRegistryConsumer(
      { registries: [BASE] },
      { token: authToken },
    );

    expect(
      consumer.resolveSecret("env://DOES_NOT_EXIST"),
    ).rejects.toThrow("Environment variable not set");
  });

  // ─── resolveConfig with file secrets ───

  test("resolveConfig resolves file:// secrets in config", async () => {
    const consumer = await createRegistryConsumer(
      { registries: [BASE] },
      { token: authToken },
    );

    const resolved = await consumer.resolveConfig({
      clientId: `file://${join(tmpDir, "notion-client-id")}`,
      clientSecret: `file://${join(tmpDir, "notion-client-secret")}`,
      apiKey: `file://${join(tmpDir, "api-key")}`,
      notASecret: "plain-value",
    });

    expect(resolved.clientId).toBe("notion_cid_abc123");
    expect(resolved.clientSecret).toBe("notion_cs_secret456");
    expect(resolved.apiKey).toBe("sk-test-key-789");
    expect(resolved.notASecret).toBe("plain-value");
  });

  // ─── unsupported scheme ───

  test("consumer throws on unsupported URI scheme", async () => {
    const consumer = await createRegistryConsumer(
      { registries: [BASE] },
      { token: authToken },
    );

    expect(
      consumer.resolveSecret("ftp://some-server/secret"),
    ).rejects.toThrow("Unsupported secret URI scheme");
  });
});
