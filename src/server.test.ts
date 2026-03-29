/**
 * E2E: atlas.slash.com ↔ registry.slash.com
 *
 * Tests the full production scenario:
 * - registry.slash.com hosts public agents (notion, linear)
 * - atlas.slash.com uses a ConsumerConfig with refs + file:// secrets
 * - createRegistryConsumer connects atlas to the registry
 * - Consumer discovers agents, resolves secrets, calls tools
 */

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
} from "./index";
import type { AgentServer, ConsumerConfig } from "./index";
import {
  type MockOIDCServer,
  startMockOIDC,
} from "./test-utils/mock-oidc-server";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// registry.slash.com — the public agent registry
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const notionAgent = defineAgent({
  path: "notion",
  entrypoint: "Notion workspace integration",
  config: {
    name: "Notion",
    description: "Search pages, query databases, create content",
  },
  visibility: "public" as const,
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
        results: [{ title: `Found: ${input.query}`, id: "page-abc" }],
      }),
    }),
    defineTool({
      name: "api",
      description: "Raw Notion API call",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string" },
          path: { type: "string" },
          body: { type: "object" },
        },
        required: ["method", "path"],
      },
      execute: async (input: { method: string; path: string }) => ({
        status: 200,
        method: input.method,
        path: input.path,
      }),
    }),
  ],
});

const linearAgent = defineAgent({
  path: "linear",
  entrypoint: "Linear project management",
  config: { name: "Linear", description: "Track issues, manage projects" },
  visibility: "public" as const,
  tools: [
    defineTool({
      name: "list_issues",
      description: "List issues",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ issues: [{ id: "ENG-1", title: "Ship it" }] }),
    }),
  ],
});

// Internal system agent — not public
const secretsAgent = defineAgent({
  path: "@secrets",
  entrypoint: "Internal secrets store",
  visibility: "internal" as const,
  tools: [
    defineTool({
      name: "get",
      description: "Get a secret",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
      execute: async () => ({ value: "s3cr3t" }),
    }),
  ],
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test suite
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("atlas ↔ registry E2E", () => {
  // --- registry.slash.com ---
  let registry: AgentServer;
  const REGISTRY_PORT = 19890;
  const REGISTRY_URL = `http://localhost:${REGISTRY_PORT}`;

  // --- atlas.slash.com secrets (file:// on disk) ---
  let secretsDir: string;
  let authToken: string;

  // --- OIDC provider ---
  let oidc: MockOIDCServer;

  beforeAll(async () => {
    // 1. Write secrets to disk (simulating atlas.slash.com's secret store)
    secretsDir = await mkdtemp(join(tmpdir(), "atlas-secrets-"));
    await writeFile(join(secretsDir, "notion-client-id"), "notion_cid_prod");
    await writeFile(join(secretsDir, "notion-client-secret"), "notion_cs_prod");
    process.env.LINEAR_API_KEY = "lin_key_prod";

    // 2. Start mock OIDC provider
    oidc = await startMockOIDC({ port: 19891 });

    // 3. Start registry.slash.com
    const reg = createAgentRegistry();
    reg.register(notionAgent);
    reg.register(linearAgent);
    reg.register(secretsAgent);

    registry = createAgentServer(reg, {
      port: REGISTRY_PORT,
      oidcProvider: {
        issuer: oidc.issuer,
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
      },
    });
    await registry.initKeys();
    await registry.start();

    // 4. Get auth token (simulating atlas user signing in)
    authToken = await registry.signJwt({
      sub: "atlas-user-001",
      email: "user@slash.com",
    });
  });

  afterAll(async () => {
    await registry?.stop?.();
    await oidc?.stop();
    await rm(secretsDir, { recursive: true, force: true });
    process.env.LINEAR_API_KEY = undefined;
  });

  // ── Discovery ──────────────────────────────────────────────────

  test("consumer discovers public agents on registry", async () => {
    const consumer = await createRegistryConsumer(
      { registries: [REGISTRY_URL] },
      { token: authToken },
    );

    const agents = await consumer.list();
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("notion");
    expect(paths).toContain("linear");
  });

  test("unauthenticated consumer sees only public agents", async () => {
    const consumer = await createRegistryConsumer({
      registries: [REGISTRY_URL],
    });

    const agents = await consumer.list();
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("notion");
    expect(paths).not.toContain("@secrets");
  });

  // ── Consumer config with refs + secrets ─────────────────────────

  test("consumer config with agent URL + file:// secrets", async () => {
    const config: ConsumerConfig = {
      refs: [
        {
          ref: "notion",
          url: `${REGISTRY_URL}/agents/notion`,
          config: {
            clientId: `file://${join(secretsDir, "notion-client-id")}`,
            clientSecret: `file://${join(secretsDir, "notion-client-secret")}`,
          },
        },
      ],
    };

    const consumer = await createRegistryConsumer(config, { token: authToken });

    // Resolve secrets
    const ref = config.refs?.[0] as { config: Record<string, string> };
    const resolved = await consumer.resolveConfig(ref.config);
    expect(resolved.clientId).toBe("notion_cid_prod");
    expect(resolved.clientSecret).toBe("notion_cs_prod");
  });

  test("consumer config with env:// secrets", async () => {
    const config: ConsumerConfig = {
      refs: [
        {
          ref: "linear",
          url: `${REGISTRY_URL}/agents/linear`,
          config: {
            apiKey: "env://LINEAR_API_KEY",
          },
        },
      ],
    };

    const consumer = await createRegistryConsumer(config, { token: authToken });
    const ref = config.refs?.[0] as { config: Record<string, string> };
    const resolved = await consumer.resolveConfig(ref.config);
    expect(resolved.apiKey).toBe("lin_key_prod");
  });

  // ── Calling agent tools ────────────────────────────────────────

  test("consumer calls notion/search_pages via registry", async () => {
    const consumer = await createRegistryConsumer(
      {
        registries: [REGISTRY_URL],
        refs: ["notion"],
      },
      { token: authToken },
    );

    const result = await consumer.call("notion", "search_pages", {
      query: "meeting notes",
    });
    expect(result).toBeDefined();
  });

  test("consumer calls linear/list_issues via registry", async () => {
    const consumer = await createRegistryConsumer(
      {
        registries: [REGISTRY_URL],
        refs: ["linear"],
      },
      { token: authToken },
    );

    const result = await consumer.call("linear", "list_issues", {});
    expect(result).toBeDefined();
  });

  test("consumer calls notion/api proxy tool", async () => {
    const consumer = await createRegistryConsumer(
      {
        registries: [REGISTRY_URL],
        refs: ["notion"],
      },
      { token: authToken },
    );

    const result = await consumer.call("notion", "api", {
      method: "GET",
      path: "/v1/pages/page-123",
    });
    expect(result).toBeDefined();
  });

  // ── OIDC sign-in flow ──────────────────────────────────────────

  test("OIDC sign-in returns JWT usable by consumer", async () => {
    // Step 1: authorize
    const r1 = await fetch(
      `${REGISTRY_URL}/signin/authorize?redirect_uri=http://localhost:9999/done`,
      { redirect: "manual" },
    );
    expect(r1.status).toBe(302);

    // Step 2: OIDC provider
    const r2 = await fetch(r1.headers.get("location")!, { redirect: "manual" });
    expect(r2.status).toBe(302);

    // Step 3: callback → JWT
    const r3 = await fetch(r2.headers.get("location")!, { redirect: "manual" });
    expect(r3.status).toBe(302);
    const jwt = new URL(r3.headers.get("location")!).searchParams.get("token")!;
    expect(jwt.split(".")).toHaveLength(3);

    // Step 4: JWT works with consumer
    const consumer = await createRegistryConsumer(
      { registries: [REGISTRY_URL] },
      { token: jwt },
    );
    const agents = await consumer.list();
    expect(agents.map((a) => a.path)).toContain("notion");
  });

  // ── Auth guards ────────────────────────────────────────────────

  test("tools/call without auth returns 401", async () => {
    const res = await fetch(`${REGISTRY_URL}/agents/notion`, {
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
  });

  test("internal agent not visible without auth", async () => {
    const res = await fetch(`${REGISTRY_URL}/agents/@secrets`);
    expect(res.status).toBe(404);
  });

  test("internal agent visible with auth", async () => {
    const res = await fetch(`${REGISTRY_URL}/agents/@secrets`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
  });

  // ── Secret URI helpers ─────────────────────────────────────────

  test("isSecretUri recognizes supported schemes", () => {
    expect(isSecretUri("file:///tmp/key")).toBe(true);
    expect(isSecretUri("env://VAR")).toBe(true);
    expect(isSecretUri("https://vault/key")).toBe(true);
    expect(isSecretUri("just-a-string")).toBe(false);
    expect(isSecretUri(42)).toBe(false);
  });
});
