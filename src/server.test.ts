import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  createAgentServer,
  createAgentRegistry,
  detectAuth,
  resolveAuth,
  canSeeAgent,
} from './index';
import type { AgentDefinition, TrustedIssuer, AgentServer } from './index';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

// ─── Helpers ─────────────────────────────────────────────────────

function makeAgent(
  path: string,
  opts: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    path,
    entrypoint: 'test',
    tools: [],
    visibility: 'internal',
    config: { name: path.split('/').pop(), supportedActions: ['load'] },
    ...opts,
  } as AgentDefinition;
}

async function mcpCall(
  port: number,
  toolName: string,
  args: Record<string, unknown>,
  authToken?: string,
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`http://localhost:${port}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  return res.json() as Promise<any>;
}

function parseResult(rpc: any): any {
  const text = rpc.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

// ─── E2E: Full server auth flow ──────────────────────────────────
//
// These tests spin up a real createAgentServer, send actual HTTP
// requests, and verify the complete path:
//   HTTP request → auth resolution → handleToolCall → registry.call → access check
//
// This is what actually broke today: authConfig was null → resolveAuth
// was skipped → trusted issuer tokens were ignored.

describe('E2E: createAgentServer with trusted issuers', () => {
  let privateKey: CryptoKey;
  let publicJwk: any;
  let jwksHttpServer: ReturnType<typeof Bun.serve>;
  let server: AgentServer;
  const JWKS_PORT = 19880;
  const SDK_PORT = 19881;
  const ISSUER_URL = `http://localhost:${JWKS_PORT}`;
  const KID = 'test-e2e-key';

  beforeAll(async () => {
    // 1. Generate ES256 keypair and serve JWKS
    const keyPair = await generateKeyPair('ES256', { extractable: true });
    privateKey = keyPair.privateKey;
    publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = KID;
    publicJwk.alg = 'ES256';
    publicJwk.use = 'sig';

    jwksHttpServer = Bun.serve({
      port: JWKS_PORT,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/.well-known/jwks.json') {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      },
    });

    // 2. Create registry with internal + public agents
    const registry = createAgentRegistry();
    registry.register(makeAgent('/agents/@clock', { visibility: 'internal' }));
    registry.register(makeAgent('/agents/public-bot', { visibility: 'public' }));

    // 3. Create server with trusted issuer — NO @auth agent registered
    //    This is the exact scenario that was broken.
    server = createAgentServer(registry, {
      port: SDK_PORT,
      trustedIssuers: [{
        issuer: ISSUER_URL,
        scopes: ['agents:admin'],
      }],
    });
    await server.start();
  });

  afterAll(() => {
    server?.stop?.();
    jwksHttpServer?.stop();
  });

  async function signToken(claims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({ sub: 'atlas-api', ...claims } as any)
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuer(ISSUER_URL)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  // ─── Core auth flow tests ───────────────────────────────────

  test('system token → can load internal agent', async () => {
    const token = await signToken();
    const rpc = await mcpCall(SDK_PORT, 'call_agent', {
      request: { action: 'load', path: '/agents/@clock' },
    }, token);

    const result = parseResult(rpc);
    expect(result.success).toBe(true);
  });

  test('no token → access denied for internal agent', async () => {
    const rpc = await mcpCall(SDK_PORT, 'call_agent', {
      request: { action: 'load', path: '/agents/@clock' },
    });

    const result = parseResult(rpc);
    expect(result.success).toBe(false);
    expect(result.code).toBe('ACCESS_DENIED');
  });

  test('no token → public agent still accessible', async () => {
    const rpc = await mcpCall(SDK_PORT, 'call_agent', {
      request: { action: 'load', path: '/agents/public-bot' },
    });

    const result = parseResult(rpc);
    expect(result.success).toBe(true);
  });

  test('garbage token → access denied', async () => {
    const rpc = await mcpCall(SDK_PORT, 'call_agent', {
      request: { action: 'load', path: '/agents/@clock' },
    }, 'not.a.valid.jwt');

    const result = parseResult(rpc);
    expect(result.success).toBe(false);
    expect(result.code).toBe('ACCESS_DENIED');
  });

  test('token with wrong issuer → access denied', async () => {
    // Sign with correct key but wrong iss claim
    const token = await new SignJWT({ sub: 'evil' } as any)
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuer('http://evil:9999') // not in trustedIssuers
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const rpc = await mcpCall(SDK_PORT, 'call_agent', {
      request: { action: 'load', path: '/agents/@clock' },
    }, token);

    const result = parseResult(rpc);
    expect(result.success).toBe(false);
    expect(result.code).toBe('ACCESS_DENIED');
  });

  // ─── Visibility in list_agents ─────────────────────────────

  test('list_agents without token → only public agents', async () => {
    const rpc = await mcpCall(SDK_PORT, 'list_agents', {});
    const result = parseResult(rpc);
    expect(result.success).toBe(true);

    const paths = result.agents.map((a: any) => a.path);
    expect(paths).toContain('/agents/public-bot');
    expect(paths).not.toContain('/agents/@clock');
  });

  test('list_agents with system token → all agents visible', async () => {
    const token = await signToken();
    const rpc = await mcpCall(SDK_PORT, 'list_agents', {}, token);
    const result = parseResult(rpc);
    expect(result.success).toBe(true);

    const paths = result.agents.map((a: any) => a.path);
    expect(paths).toContain('/agents/public-bot');
    expect(paths).toContain('/agents/@clock');
  });

  // ─── Scopes: limited issuer ────────────────────────────────

  test('issuer with limited scopes → resolves as agent, not system', async () => {
    // Create a separate server with limited-scope issuer
    const limitedRegistry = createAgentRegistry();
    limitedRegistry.register(makeAgent('/agents/@private-agent', { visibility: 'private' }));
    limitedRegistry.register(makeAgent('/agents/@internal-agent', { visibility: 'internal' }));

    const limitedServer = createAgentServer(limitedRegistry, {
      port: 19882,
      trustedIssuers: [{
        issuer: ISSUER_URL,
        scopes: ['agents:read'], // NOT agents:admin or *
      }],
    });
    await limitedServer.start();

    try {
      const token = await signToken();

      // agents:read grants agent-level access (not system)
      // Internal agents are accessible to authenticated agents
      const internalRpc = await mcpCall(19882, 'call_agent', {
        request: { action: 'load', path: '/agents/@internal-agent' },
      }, token);
      expect(parseResult(internalRpc).success).toBe(true);

      // Private agents should be denied (only self can access)
      const privateRpc = await mcpCall(19882, 'call_agent', {
        request: { action: 'load', path: '/agents/@private-agent' },
      }, token);
      expect(parseResult(privateRpc).success).toBe(false);
      expect(parseResult(privateRpc).code).toBe('ACCESS_DENIED');
    } finally {
      limitedServer?.stop?.();
    }
  });
});

// ─── Unit: detectAuth ────────────────────────────────────────────

describe('detectAuth', () => {
  test('returns non-null even without @auth agent', () => {
    const registry = createAgentRegistry();
    const config = detectAuth(registry);
    expect(config).toBeDefined();
    expect(config).not.toBeNull();
  });

  test('returns empty config (no store, no rootKey) without @auth agent', () => {
    const registry = createAgentRegistry();
    const config = detectAuth(registry);
    expect(config.store).toBeUndefined();
    expect(config.rootKey).toBeUndefined();
  });
});

// ─── Unit: canSeeAgent ───────────────────────────────────────────

describe('canSeeAgent', () => {
  test('system auth can see internal agents', () => {
    const agent = makeAgent('/agents/@clock', { visibility: 'internal' });
    const auth = { callerId: 'api', callerType: 'system' as const, scopes: ['*'], isRoot: true };
    expect(canSeeAgent(agent, auth)).toBe(true);
  });

  test('null auth cannot see internal agents', () => {
    const agent = makeAgent('/agents/@clock', { visibility: 'internal' });
    expect(canSeeAgent(agent, null)).toBe(false);
  });

  test('null auth can see public agents', () => {
    const agent = makeAgent('/agents/public', { visibility: 'public' });
    expect(canSeeAgent(agent, null)).toBe(true);
  });
});
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createAgentServer,
  createAgentRegistry,
  createAuthAgent,
  defineAgent,
  defineTool,
} from "./index";
import type { AgentServer } from "./index";

// ─── Agents ──────────────────────────────────────────────────────

const notionAgent = defineAgent({
  path: "notion",
  entrypoint: "Notion integration agent",
  config: { name: "Notion", description: "Connect to Notion workspaces" },
  visibility: "public",
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
        results: [{ title: `Result for: ${input.query}`, id: "page-123" }],
      }),
    }),
    defineTool({
      name: "api",
      description: "Make a raw API call to Notion",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] },
          path: { type: "string", description: "API path (e.g. /v1/pages)" },
          body: { type: "object", description: "Request body" },
        },
        required: ["method", "path"],
      },
      execute: async (input: { method: string; path: string; body?: unknown }) => ({
        status: 200,
        data: { mock: true, method: input.method, path: input.path },
      }),
    }),
  ],
});

const linearAgent = defineAgent({
  path: "linear",
  entrypoint: "Linear integration agent",
  config: { name: "Linear", description: "Connect to Linear workspaces" },
  visibility: "public",
  tools: [
    defineTool({
      name: "list_issues",
      description: "List issues from Linear",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ issues: [{ id: "LIN-1", title: "Fix bug" }] }),
    }),
    defineTool({
      name: "api",
      description: "Make a raw GraphQL call to Linear",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "GraphQL query" },
          variables: { type: "object", description: "Variables" },
        },
        required: ["query"],
      },
      execute: async (input: { query: string }) => ({
        data: { mock: true, query: input.query },
      }),
    }),
  ],
});

// Internal agent (no visibility) — should NOT appear under /agents
const internalAgent = defineAgent({
  path: "@internal",
  entrypoint: "Internal system agent",
  tools: [
    defineTool({
      name: "whoami",
      description: "Who am I",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ user: "admin" }),
    }),
  ],
});

// Internal with explicit visibility
const secretsAgent = defineAgent({
  path: "@secrets",
  entrypoint: "Secrets agent",
  visibility: "internal",
  tools: [
    defineTool({
      name: "get_secret",
      description: "Get a secret",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      execute: async () => ({ value: "s3cr3t" }),
    }),
  ],
});

// ─── Tests ─────────────────────────────────────────────────────

describe("/agents routing", () => {
  let server: AgentServer;
  let authToken: string;
  const PORT = 19895;
  const BASE = `http://localhost:${PORT}`;

  beforeAll(async () => {
    const registry = createAgentRegistry();
    registry.register(notionAgent);
    registry.register(linearAgent);
    registry.register(internalAgent);
    registry.register(secretsAgent);

    server = createAgentServer(registry, { port: PORT });
    await server.initKeys();
    await server.start();

    // Get an auth token for authenticated tests
    authToken = await server.signJwt({
      sub: "test-user",
      email: "test@example.com",
    });
  });

  afterAll(async () => {
    await server?.stop?.();
  });

  function authHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    };
  }

  // ─── Discovery (no auth needed) ───────────────────────────

  test("GET /agents lists only agents with explicit visibility (no auth)", async () => {
    const res = await fetch(`${BASE}/agents`);
    expect(res.status).toBe(200);
    const agents = (await res.json()) as { path: string }[];
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("notion");
    expect(paths).toContain("linear");
    expect(paths).not.toContain("@internal"); // no visibility = not listed
    expect(paths).not.toContain("@secrets"); // internal visibility = needs auth
  });

  test("GET /agents with auth shows internal agents too", async () => {
    const res = await fetch(`${BASE}/agents`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const agents = (await res.json()) as { path: string }[];
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("notion");
    expect(paths).toContain("linear");
    expect(paths).toContain("@secrets"); // internal visible with auth
    expect(paths).not.toContain("@internal"); // still hidden (no visibility set)
  });

  test("GET /agents/notion returns tool info (no auth)", async () => {
    const res = await fetch(`${BASE}/agents/notion`);
    expect(res.status).toBe(200);
    const agent = (await res.json()) as {
      path: string;
      name: string;
      tools: { name: string; inputSchema: unknown }[];
    };
    expect(agent.path).toBe("notion");
    expect(agent.name).toBe("Notion");
    expect(agent.tools.map((t) => t.name)).toContain("search_pages");
    expect(agent.tools.map((t) => t.name)).toContain("api");
    // Full schemas on single-agent endpoint
    expect(agent.tools.find((t) => t.name === "search_pages")!.inputSchema).toBeDefined();
  });

  test("GET /agents/unknown returns 404", async () => {
    const res = await fetch(`${BASE}/agents/unknown`);
    expect(res.status).toBe(404);
  });

  test("GET /agents/@secrets without auth returns 404", async () => {
    const res = await fetch(`${BASE}/agents/@secrets`);
    expect(res.status).toBe(404); // canSeeAgent returns false
  });

  test("GET /agents/@secrets with auth returns agent info", async () => {
    const res = await fetch(`${BASE}/agents/@secrets`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const agent = (await res.json()) as { path: string };
    expect(agent.path).toBe("@secrets");
  });

  // ─── tools/list (still discovery, no auth needed) ───────

  test("POST /agents/notion tools/list works without auth", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    const data = (await res.json()) as { result: { tools: { name: string }[] } };
    const toolNames = data.result.tools.map((t) => t.name);
    expect(toolNames).toContain("search_pages");
    expect(toolNames).toContain("api");
    expect(toolNames).not.toContain("list_issues"); // linear tool
  });

  // ─── tools/call (auth required) ────────────────────────

  test("POST /agents/notion tools/call WITHOUT auth returns 401", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
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
    const data = (await res.json()) as { error: { message: string } };
    expect(data.error.message).toContain("Authentication required");
  });

  test("POST /agents/notion tools/call WITH auth succeeds", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_pages", arguments: { query: "meeting notes" } },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: unknown };
    expect(data.result).toBeDefined();
  });

  test("POST /agents/notion api proxy tool WITH auth", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "api",
          arguments: { method: "GET", path: "/v1/pages/page-123" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: unknown };
    expect(data.result).toBeDefined();
  });

  test("POST /agents/linear tools/call WITH auth", async () => {
    const res = await fetch(`${BASE}/agents/linear`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_issues", arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
  });

  // ─── initialize ───────────────────────────────────────

  test("POST /agents/notion initialize returns agent-scoped server info", async () => {
    const res = await fetch(`${BASE}/agents/notion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    const data = (await res.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(data.result.serverInfo.name).toBe("Notion");
  });

  // ─── Legacy ───────────────────────────────────────────

  test("GET /list still works (legacy)", async () => {
    const res = await fetch(`${BASE}/list`);
    expect(res.status).toBe(200);
    const agents = (await res.json()) as { path: string }[];
    expect(agents.length).toBeGreaterThanOrEqual(2);
  });
});
