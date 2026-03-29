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

const publicAgent = defineAgent({
  path: "@public-bot",
  entrypoint: "A public agent",
  tools: [echo],
  visibility: "public",
});

const internalAgent = defineAgent({
  path: "@internal-bot",
  entrypoint: "An internal agent",
  tools: [echo],
  visibility: "internal",
});

const ROOT_KEY = "test-root-key-for-auth";
const PORT = 19892;

async function callRpc(
  port: number,
  toolName: string,
  args: Record<string, unknown>,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`http://localhost:${port}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  return res.json() as Promise<any>;
}

function parseResult(rpc: any): any {
  const text = rpc.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

// ─── E2E: Consumer with @auth ────────────────────────────────────

describe("Registry Consumer with @auth", () => {
  let server: AgentServer;
  let accessToken: string;

  beforeAll(async () => {
    const registry = createAgentRegistry();
    registry.register(
      createAuthAgent({
        rootKey: ROOT_KEY,
        allowRegistration: true,
      }),
    );
    registry.register(publicAgent);
    registry.register(internalAgent);

    server = createAgentServer(registry, { port: PORT });
    await server.initKeys();
    await server.start();

    // Sign a JWT with the server's own keys (this is how cross-registry auth works)
    accessToken = await server.signJwt({ sub: "test-consumer", scopes: ["*"] });
  });

  afterAll(async () => {
    await server?.stop?.();
  });

  test("consumer can list public agents without auth", async () => {
    const consumer = await createRegistryConsumer({
      registries: [`http://localhost:${PORT}`],
      refs: ["@public-bot"],
    });

    const agents = await consumer.list();
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("@public-bot");
  });

  test("consumer with token can list internal agents", async () => {
    const consumer = await createRegistryConsumer(
      {
        registries: [`http://localhost:${PORT}`],
        refs: ["@internal-bot"],
      },
      { token: accessToken },
    );

    const agents = await consumer.list();
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("@internal-bot");
  });

  test("consumer without token cannot see internal agents", async () => {
    const consumer = await createRegistryConsumer({
      registries: [`http://localhost:${PORT}`],
    });

    const agents = await consumer.list();
    const paths = agents.map((a) => a.path);
    expect(paths).not.toContain("@internal-bot");
    // But public should still be visible
    expect(paths).toContain("@public-bot");
  });

  test("consumer with token can call internal agent tools", async () => {
    const consumer = await createRegistryConsumer(
      {
        registries: [`http://localhost:${PORT}`],
        refs: ["@internal-bot"],
      },
      { token: accessToken },
    );

    const result = await consumer.call("@internal-bot", "echo", {
      message: "hello from auth",
    });
    expect(result).toBeDefined();
  });

  test("consumer can call public agent without token", async () => {
    const consumer = await createRegistryConsumer({
      registries: [`http://localhost:${PORT}`],
      refs: ["@public-bot"],
    });

    const result = await consumer.call("@public-bot", "echo", {
      message: "no auth needed",
    });
    expect(result).toBeDefined();
  });

  test("available() respects auth — shows what authed user can add", async () => {
    // With token: should see internal agents as available
    const authed = await createRegistryConsumer(
      {
        registries: [`http://localhost:${PORT}`],
        refs: ["@public-bot"],
      },
      { token: accessToken },
    );
    const authedAvailable = await authed.available();
    const authedPaths = authedAvailable.map((a) => a.path);
    expect(authedPaths).toContain("@internal-bot");

    // Without token: should NOT see internal agents
    const unauthed = await createRegistryConsumer({
      registries: [`http://localhost:${PORT}`],
      refs: ["@public-bot"],
    });
    const unauthedAvailable = await unauthed.available();
    const unauthedPaths = unauthedAvailable.map((a) => a.path);
    expect(unauthedPaths).not.toContain("@internal-bot");
  });
});
