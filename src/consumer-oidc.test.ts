import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createAgentServer,
  createAgentRegistry,
  createAuthAgent,
  defineAgent,
  defineTool,
  createRegistryConsumer,
} from "./index";
import type { AgentServer } from "./index";
import { startMockOIDC, type MockOIDCServer } from "./test-utils/mock-oidc-server";

// ─── Agents ──────────────────────────────────────────────────────

const secretTool = defineTool({
  name: "get_secret",
  description: "Returns a secret value",
  inputSchema: {
    type: "object",
    properties: {},
  },
  execute: async () => ({ secret: "top-secret-value" }),
});

const internalAgent = defineAgent({
  path: "@secrets",
  entrypoint: "Internal secrets agent",
  tools: [secretTool],
  visibility: "internal",
});

const publicAgent = defineAgent({
  path: "@public",
  entrypoint: "Public agent",
  tools: [
    defineTool({
      name: "ping",
      description: "Ping",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ pong: true }),
    }),
  ],
  visibility: "public",
});

// ─── E2E: OIDC → Registry → Consumer ─────────────────────────────
//
// Flow:
// 1. Mock OIDC server acts as identity provider
// 2. Registry trusts the OIDC issuer
// 3. Registry signs its own JWT after verifying OIDC identity
// 4. Consumer uses the registry-signed JWT
//
// This mirrors the production flow:
//   User → Slack/Google OIDC → Registry → JWT → Consumer

describe("Consumer with OIDC flow", () => {
  let oidc: MockOIDCServer;
  let server: AgentServer;
  const REGISTRY_PORT = 19893;
  const ROOT_KEY = "test-root-key-oidc";

  beforeAll(async () => {
    // 1. Start mock OIDC provider
    oidc = await startMockOIDC({ port: 19894 });

    // 2. Start registry that trusts the OIDC issuer
    const registry = createAgentRegistry();
    registry.register(
      createAuthAgent({ rootKey: ROOT_KEY, allowRegistration: true }),
    );
    registry.register(internalAgent);
    registry.register(publicAgent);

    server = createAgentServer(registry, {
      port: REGISTRY_PORT,
      trustedIssuers: [
        {
          issuer: oidc.issuer,
          scopes: ["agents:read", "agents:call"],
        },
      ],
    });
    await server.initKeys();
    await server.start();
  });

  afterAll(async () => {
    await server?.stop?.();
    await oidc?.stop();
  });

  test("registry signs JWT for authenticated user", async () => {
    // Simulate: after OIDC flow completes, registry signs its own JWT
    // with the user's identity claims
    const jwt = await server.signJwt({
      sub: oidc.testUser.sub,
      email: oidc.testUser.email,
      name: oidc.testUser.name,
      provider: "oidc",
      oidc_issuer: oidc.issuer,
    });

    expect(jwt).toBeDefined();
    expect(jwt.split(".")).toHaveLength(3); // valid JWT format
  });

  test("consumer with OIDC-originated JWT can list all agents", async () => {
    const jwt = await server.signJwt({
      sub: oidc.testUser.sub,
      email: oidc.testUser.email,
    });

    const consumer = await createRegistryConsumer(
      {
        registries: [`http://localhost:${REGISTRY_PORT}`],
      },
      { token: jwt },
    );

    const agents = await consumer.list();
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("@secrets");
    expect(paths).toContain("@public");
  });

  test("consumer with OIDC JWT can call internal agent", async () => {
    const jwt = await server.signJwt({
      sub: oidc.testUser.sub,
      email: oidc.testUser.email,
    });

    const consumer = await createRegistryConsumer(
      {
        registries: [`http://localhost:${REGISTRY_PORT}`],
        refs: ["@secrets"],
      },
      { token: jwt },
    );

    const result = await consumer.call("@secrets", "get_secret", {});
    expect(result).toBeDefined();
  });

  test("consumer without JWT can only see public agents", async () => {
    const consumer = await createRegistryConsumer({
      registries: [`http://localhost:${REGISTRY_PORT}`],
    });

    const agents = await consumer.list();
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("@public");
    expect(paths).not.toContain("@secrets");
  });

  test("OIDC userinfo endpoint returns expected claims", async () => {
    // Verify the mock OIDC server works as expected
    const res = await fetch(`${oidc.url}/userinfo`, {
      headers: { Authorization: `Bearer ${oidc.accessToken}` },
    });
    const userinfo = (await res.json()) as Record<string, unknown>;

    expect(userinfo.sub).toBe("test-user-001");
    expect(userinfo.email).toBe("test@example.com");
    expect(userinfo.name).toBe("Test User");
  });

  test("OIDC discovery endpoint returns configuration", async () => {
    const res = await fetch(
      `${oidc.url}/.well-known/openid-configuration`,
    );
    const config = (await res.json()) as Record<string, unknown>;

    expect(config.issuer).toBe(oidc.url);
    expect(config.authorization_endpoint).toBeDefined();
    expect(config.token_endpoint).toBeDefined();
    expect(config.userinfo_endpoint).toBeDefined();
  });
});
