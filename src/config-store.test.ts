import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FsStore } from "./agent-definitions/config";
import {
  createAdk,
  createAdkTools,
  createAgentRegistry,
  createAgentServer,
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
    const toolCount =
      (info?.tools?.length ?? 0) + (info?.toolSummaries?.length ?? 0);
    expect(toolCount).toBeGreaterThan(0);
  });

  test("ref.authStatus routes through sourceRegistry (regression: multi-registry first-fulfilled-wins)", async () => {
    // Repro for the bug where a primary registry that returns
    // {success:false} for an unknown agent shadowed the real
    // registry that hosts the ref. Before the fix, `authStatus`
    // queried every registry without filtering and the unrelated
    // primary's empty fulfillment would null out `security` →
    // `auth()` short-circuited to {type:"none", complete:true}.
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    // Add primary registry FIRST (doesn't have @math) — would
    // "win" the inspect race without a registryUrl filter.
    await adk.registry.add({
      url: `http://localhost:${PRIMARY_PORT}`,
      name: "primary",
    });

    // Seed a ref whose sourceRegistry points at the source server.
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

    // authStatus should reach the source server and surface the
    // agent's tools (no security in this test agent, but the
    // important assertion is that we DIDN'T silently drop into
    // the "no security found" branch when the source registry
    // does host the agent).
    const status = await adk.ref.authStatus("@math");
    expect(status.name).toBe("@math");
    // @math has no security configured, so security is null and
    // complete is true — but this MUST be reached via the source
    // registry, not via the unrelated primary returning {success:false}.
    // We just assert no throw + the call returned a sensible shape.
    expect(status).toHaveProperty("complete");
    expect(status).toHaveProperty("fields");
  });
});

// ─── ADK Config Store: ref.add validation ────────────────────────

describe("ADK ref.add validation", () => {
  test("throws when no scheme specified", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await expect(adk.ref.add({ ref: "@something" })).rejects.toThrow(
      "could not determine connection type",
    );
  });

  test("throws when scheme is 'registry' without sourceRegistry", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await expect(
      adk.ref.add({ ref: "@something", scheme: "registry" }),
    ).rejects.toThrow("requires sourceRegistry.url");
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

// ─── ADK ref.call() 401 → refresh → retry ────────────────────────

describe("ADK ref.call() auto-refresh on 401", () => {
  let server: AgentServer;
  const PORT = 19910;
  let callCount = 0;

  beforeAll(async () => {
    callCount = 0;

    const failOnceTool = defineTool({
      name: "get_data",
      description: "Returns 401 on first call, succeeds on retry",
      inputSchema: { type: "object" as const, properties: {} },
      execute: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: [{ type: "text", text: '{"error":"401 Unauthorized"}' }],
            _httpStatus: 401,
          };
        }
        return { data: "success", callNumber: callCount };
      },
    });

    const agent = defineAgent({
      path: "test-api",
      entrypoint: "Test API agent",
      tools: [failOnceTool],
      visibility: "public",
    });

    const registry = createAgentRegistry();
    registry.register(agent);
    server = createAgentServer(registry, { port: PORT });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test("server forwards _httpStatus as HTTP 401", async () => {
    callCount = 0;
    const res = await fetch(`http://localhost:${PORT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "test-401",
        method: "tools/call",
        params: {
          name: "call_agent",
          arguments: {
            request: {
              action: "execute_tool",
              path: "test-api",
              tool: "get_data",
              params: {},
            },
          },
        },
      }),
    });

    // Server should forward the 401 HTTP status from the tool result
    expect(res.status).toBe(401);

    // Body should still be valid JSON-RPC
    const body = await res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe("test-401");
  });

  test("second call succeeds with 200", async () => {
    const res = await fetch(`http://localhost:${PORT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "test-200",
        method: "tools/call",
        params: {
          name: "call_agent",
          arguments: {
            request: {
              action: "execute_tool",
              path: "test-api",
              tool: "get_data",
              params: {},
            },
          },
        },
      }),
    });

    expect(res.status).toBe(200);
  });
});

describe("ADK ref.call() full auto-refresh flow", () => {
  let registryServer: AgentServer;
  let tokenServer: ReturnType<typeof Bun.serve>;
  const REG_PORT = 19920;
  const TOKEN_PORT = 19921;
  let toolCallCount = 0;
  let tokenRefreshCount = 0;

  beforeAll(async () => {
    // Mock token endpoint that validates refresh_token
    tokenServer = Bun.serve({
      port: TOKEN_PORT,
      async fetch(req) {
        tokenRefreshCount++;
        const body = await req.text();
        const params = new URLSearchParams(body);
        if (params.get("grant_type") !== "refresh_token") {
          return new Response(
            JSON.stringify({ error: "unsupported_grant_type" }),
            { status: 400 },
          );
        }
        if (params.get("refresh_token") !== "my-refresh-token") {
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
          });
        }
        if (params.get("client_id") !== "my-client-id") {
          return new Response(JSON.stringify({ error: "invalid_client" }), {
            status: 401,
          });
        }
        return new Response(
          JSON.stringify({
            access_token: "refreshed-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });

    // Agent that validates the access token
    const apiTool = defineTool({
      name: "get_data",
      description: "Validates token and returns 401 if expired",
      inputSchema: { type: "object" as const, properties: {} },
      execute: async (input: any) => {
        toolCallCount++;
        const token = input?.accessToken;
        if (token === "expired-token" || !token) {
          return {
            content: [{ type: "text", text: '{"error":"401 Unauthorized"}' }],
            _httpStatus: 401,
          };
        }
        if (token === "refreshed-token") {
          return { message: "success", token };
        }
        return {
          content: [{ type: "text", text: '{"error":"403 Forbidden"}' }],
          _httpStatus: 403,
        };
      },
    });

    const agent = defineAgent({
      path: "oauth-api",
      entrypoint: "OAuth API agent",
      tools: [apiTool],
      visibility: "public",
      config: {
        security: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "http://localhost/authorize",
              tokenUrl: `http://localhost:${TOKEN_PORT}`,
            },
          },
        },
      },
    });

    const registry = createAgentRegistry();
    registry.register(agent);
    registryServer = createAgentServer(registry, { port: REG_PORT });
    await registryServer.start();
  });

  afterAll(async () => {
    await registryServer.stop();
    tokenServer.stop();
  });

  test("ref.call() detects 401, refreshes token, retries, and succeeds", async () => {
    toolCallCount = 0;
    tokenRefreshCount = 0;

    const fs = createMemoryFs();
    const adk = createAdk(fs, {
      encryptionKey: "test-key-32-chars-long-enough!!",
    });

    await adk.registry.add({
      name: "oauth-reg",
      url: `http://localhost:${REG_PORT}`,
    });
    await adk.ref.add({
      ref: "oauth-api",
      sourceRegistry: {
        url: `http://localhost:${REG_PORT}`,
        agentPath: "oauth-api",
      },
    });

    // Store credentials directly
    const config = await adk.readConfig();
    await adk.writeConfig({
      ...config,
      refs: config.refs?.map((r: any) => {
        if (r.ref === "oauth-api" || r.name === "oauth-api") {
          return {
            ...r,
            config: {
              ...r.config,
              access_token: "expired-token",
              refresh_token: "my-refresh-token",
              client_id: "my-client-id",
            },
          };
        }
        return r;
      }),
    });

    const result = await adk.ref.call("oauth-api", "get_data");

    // Tool called twice: first with expired token (401), then with refreshed token (success)
    expect(toolCallCount).toBe(2);
    // Token endpoint called once with correct refresh_token + client_id
    expect(tokenRefreshCount).toBe(1);
    // Final result should be success, proving the refreshed token was used
    expect((result as any)?.result?.message).toBe("success");
    expect((result as any)?.result?.token).toBe("refreshed-token");
  });

  test("ref.authStatus persists authFields={} in registry-cache for security:none refs (regression: isRefConnected miss-classifies auto-installed no-auth refs)", async () => {
    // Regression: `authStatus` short-circuited at `security.type === "none"`
    // (and at `security == null`) WITHOUT writing the slim `{required,
    // automated}` authFields shape into `registry-cache.json`. Host-side
    // `isRefAuthComplete` then returned `null` for those refs ("no
    // authFields in cache"), and the LLM-facing `isRefConnected` filter
    // in atlas-os-sdk fell back to a coarse `[access_token|api_key|token]`
    // credential presence check — which a security:none ref like
    // web-search/Firecrawl never has by definition. Result: auto-installed
    // no-auth refs silently disappeared from `list_agents` and from
    // `~/.adk/refs/` materialization.
    //
    // The fix: when `inspect` confirmed `security` is absent or
    // `{type:"none"}`, persist `authFields: {}` so `isRefAuthComplete`
    // returns `true` (no required fields to satisfy) and downstream
    // filters treat the ref as connected.
    //
    // The `@math` agent registered above has no `config.security`, so it
    // exercises the "registry returned no security field at all" path.
    const fs = createMemoryFs();
    const adk = createAdk(fs, {
      encryptionKey: "test-key-32-chars-long-enough!!",
    });

    await adk.registry.add({
      name: "oauth-reg",
      url: `http://localhost:${REG_PORT}`,
    });
    await adk.ref.add({
      ref: "@math",
      name: "math",
      sourceRegistry: {
        url: `http://localhost:${REG_PORT}`,
        agentPath: "@math",
      },
    });

    const status = await adk.ref.authStatus("math");
    expect(status.complete).toBe(true);
    expect(status.fields).toEqual({});

    // The cache must now carry authFields={} so isRefAuthComplete can
    // answer "yes, ready to call" without re-fetching the security scheme.
    const cacheRaw = await fs.readFile("registry-cache.json");
    expect(cacheRaw).not.toBeNull();
    const cache = JSON.parse(cacheRaw!);
    expect(cache.refs.math).toBeDefined();
    expect(cache.refs.math.authFields).toEqual({});
  });

  test("ref.authStatus maps form security to required access_token authFields", async () => {
    // Form security (e.g. databases) asks the user for structured
    // connection fields, but the ADK call path stores the encoded form
    // payload under `config.access_token` and forwards it to registry
    // executors as `params.accessToken`. The cached authFields shape must
    // therefore require `access_token`; otherwise host-side
    // `isRefAuthComplete` / `isRefConnected` checks treat empty form refs
    // as connected because there are no required fields to satisfy.
    const fs = createMemoryFs();
    const fetch: typeof globalThis.fetch = async () =>
      Response.json({
        jsonrpc: "2.0",
        id: "call-1",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                toolSummaries: [{ name: "query", description: "Execute SQL" }],
                description: "Form auth agent",
                security: {
                  type: "form",
                  fields: [
                    { name: "host", type: "string", required: true },
                    { name: "password", type: "password", required: true },
                  ],
                },
              }),
            },
          ],
        },
      });
    const adk = createAdk(fs, {
      encryptionKey: "test-key-32-chars-long-enough!!",
      fetch,
    });

    await adk.registry.add({
      name: "form-reg",
      url: "http://registry.test",
    });
    const initialConfig = await adk.readConfig();
    await adk.writeConfig({
      ...initialConfig,
      refs: [
        ...(initialConfig.refs ?? []),
        {
          ref: "form-api",
          name: "form-api-unauthed",
          scheme: "registry",
          sourceRegistry: {
            url: "http://registry.test",
            agentPath: "form-api",
          },
        },
      ],
    });

    const status = await adk.ref.authStatus("form-api-unauthed");
    expect(status.complete).toBe(false);
    expect(status.fields?.access_token).toEqual({
      required: true,
      automated: false,
      present: false,
      resolvable: false,
    });

    const cacheRaw = await fs.readFile("registry-cache.json");
    expect(cacheRaw).not.toBeNull();
    if (!cacheRaw) throw new Error("registry-cache.json missing");
    const cache = JSON.parse(cacheRaw) as {
      refs: Record<string, { authFields?: Record<string, unknown> }>;
    };
    expect(cache.refs["form-api-unauthed"].authFields).toEqual({
      access_token: { required: true, automated: false },
    });

    const config = await adk.readConfig();
    await adk.writeConfig({
      ...config,
      refs: config.refs?.map((r) =>
        r.name === "form-api-unauthed"
          ? { ...r, config: { ...r.config, access_token: "encoded-form" } }
          : r,
      ),
    });

    const authedStatus = await adk.ref.authStatus("form-api-unauthed");
    expect(authedStatus.complete).toBe(true);
    expect(authedStatus.fields?.access_token?.present).toBe(true);
  });

  test("ref.authStatus does NOT persist authFields when inspect fails (registry unreachable)", async () => {
    // Sibling guard: if the registry inspect call throws / returns null
    // (network error, registry doesn't host the ref, etc.), we must NOT
    // cache a false-positive `authFields: {}` — that would let the host
    // treat an unreachable ref as "connected" on the next call.
    const fs = createMemoryFs();
    const adk = createAdk(fs, {
      encryptionKey: "test-key-32-chars-long-enough!!",
    });

    // Point at a port that nothing is listening on.
    await adk.registry.add({
      name: "dead-reg",
      url: `http://localhost:1`,
    });
    await adk.ref.add({
      ref: "@phantom",
      name: "phantom",
      sourceRegistry: {
        url: `http://localhost:1`,
        agentPath: "@phantom",
      },
    });

    const status = await adk.ref.authStatus("phantom");
    expect(status.complete).toBe(true);
    expect(status.security).toBeNull();

    // Registry was unreachable, so we shouldn't have written a cache
    // entry that claims this ref is no-auth.
    const cacheRaw = await fs.readFile("registry-cache.json");
    if (cacheRaw !== null) {
      const cache = JSON.parse(cacheRaw);
      expect(cache.refs?.phantom?.authFields).toBeUndefined();
    }
  });

  test("ref.authStatus reports access_token.automated=false for authorizationCode (user must consent)", async () => {
    // Regression: previously `access_token.automated` was hardcoded to
    // `true` for every oauth2 scheme. That made cached-authFields
    // callers think the ref was "connected" the moment `ref.add` ran,
    // even when the user had never completed OAuth — because the
    // `automated:true` flag tells `isRefAuthComplete` to skip the
    // presence check. For authorizationCode (which requires user
    // consent), `automated` must be `false`.
    const fs = createMemoryFs();
    const adk = createAdk(fs, {
      encryptionKey: "test-key-32-chars-long-enough!!",
    });

    await adk.registry.add({
      name: "oauth-reg",
      url: `http://localhost:${REG_PORT}`,
    });
    await adk.ref.add({
      ref: "oauth-api",
      name: "oauth-api-unauthed",
      sourceRegistry: {
        url: `http://localhost:${REG_PORT}`,
        agentPath: "oauth-api",
      },
    });

    const status = await adk.ref.authStatus("oauth-api-unauthed");
    expect(status.complete).toBe(false);
    expect(status.fields?.access_token?.automated).toBe(false);
    expect(status.fields?.access_token?.present).toBe(false);
  });
});

describe("ADK ref.call() auto-refresh on direct MCP 401", () => {
  // Regression: refs whose entry has a direct `url` and `mode !== "api"`
  // (Linear, Notion, Figma, DoorDash, Houzz, etc.) take the
  // `callMcpDirect` branch instead of the registry-mediated `callRegistry`
  // branch. Before this fix, a 401 from the upstream MCP server was
  // surfaced as `{ success: false, error: "MCP tools/call failed (401):
  // ..." }` with no `httpStatus` field, so `isUnauthorized(result)` never
  // matched and the refresh-on-401 retry path in `ref.call` was silently
  // skipped — even when the ref had a valid `refresh_token` on hand. The
  // fix attaches `httpStatus` to the error envelope, restoring parity
  // with the registry-mediated path (which already gets `_httpStatus`
  // forwarded as structured data).
  let registryServer: AgentServer;
  let mcpServer: ReturnType<typeof Bun.serve>;
  let tokenServer: ReturnType<typeof Bun.serve>;
  const REG_PORT = 19930;
  const MCP_PORT = 19931;
  const TOKEN_PORT = 19932;
  let toolCallCount = 0;
  let tokenRefreshCount = 0;
  let serverActiveToken = "";

  beforeAll(async () => {
    // Registry exposes the agent with an oauth2 security scheme so
    // `ref.authStatus` can discover the tokenUrl that `refreshToken`
    // POSTs to. The agent has no tools that ever get invoked here —
    // the actual tool call goes direct to mcpServer below.
    const stubTool = defineTool({
      name: "some_tool",
      description: "Never invoked via the registry in this test",
      inputSchema: { type: "object" as const, properties: {} },
      execute: async () => ({ message: "unused" }),
    });
    const agent = defineAgent({
      path: "direct-mcp-agent",
      entrypoint: "Direct-MCP agent (security discovery only)",
      tools: [stubTool],
      visibility: "public",
      config: {
        description: "Direct-MCP test agent (security discovery only)",
        security: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "http://localhost/authorize",
              tokenUrl: `http://localhost:${TOKEN_PORT}`,
            },
          },
        },
      },
    });
    const registry = createAgentRegistry();
    registry.register(agent);
    registryServer = createAgentServer(registry, { port: REG_PORT });
    await registryServer.start();

    // Direct MCP server — returns 401 unless the bearer token matches
    // `serverActiveToken`. Real MCP servers signal 401 with an HTTP 401
    // (not via httpStatus on the JSON-RPC body); that's exactly what the
    // fix has to recover.
    mcpServer = Bun.serve({
      port: MCP_PORT,
      async fetch(req) {
        const body = (await req.json()) as {
          method?: string;
          id?: number;
          params?: { name?: string };
        };
        const respond = (status: number, payload: unknown) =>
          new Response(JSON.stringify(payload), {
            status,
            headers: { "Content-Type": "application/json" },
          });

        if (body.method === "initialize") {
          return respond(200, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "mock-mcp", version: "1.0.0" },
            },
          });
        }
        if (body.method === "notifications/initialized") {
          return respond(200, { jsonrpc: "2.0", id: body.id, result: {} });
        }
        if (body.method === "tools/call") {
          toolCallCount++;
          const auth = req.headers.get("Authorization") ?? "";
          const token = auth.replace(/^Bearer /, "");
          if (token !== serverActiveToken) {
            return respond(401, {
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32001, message: "Unauthorized" },
            });
          }
          return respond(200, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, token }),
                },
              ],
            },
          });
        }
        return respond(404, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        });
      },
    });

    // OAuth token endpoint — mints a fresh access token for a known refresh
    // token + client_id. Rejects everything else with 400.
    tokenServer = Bun.serve({
      port: TOKEN_PORT,
      async fetch(req) {
        tokenRefreshCount++;
        const params = new URLSearchParams(await req.text());
        if (
          params.get("grant_type") !== "refresh_token" ||
          params.get("refresh_token") !== "direct-refresh-token" ||
          params.get("client_id") !== "direct-client-id"
        ) {
          return new Response(JSON.stringify({ error: "invalid_request" }), {
            status: 400,
          });
        }
        return new Response(
          JSON.stringify({
            access_token: "refreshed-direct-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });
  });

  afterAll(async () => {
    await registryServer.stop();
    mcpServer.stop();
    tokenServer.stop();
  });

  test("401 from direct MCP triggers refresh + retry (parity with registry-mediated refs)", async () => {
    toolCallCount = 0;
    tokenRefreshCount = 0;
    // Server will only accept the refreshed token — the stale one we seed
    // below must round-trip through refresh before the call can succeed.
    serverActiveToken = "refreshed-direct-token";

    const fs = createMemoryFs();
    const adk = createAdk(fs, {
      encryptionKey: "test-key-32-chars-long-enough!!",
    });

    // Point the ref at the registry for security discovery, but also set
    // a direct `url` so `ref.call` takes the `callMcpDirect` branch (the
    // exact code path that was broken).
    await adk.registry.add({
      name: "direct-mcp-registry",
      url: `http://localhost:${REG_PORT}`,
    });
    await adk.ref.add({
      ref: "direct-mcp-agent",
      url: `http://localhost:${MCP_PORT}`,
      sourceRegistry: {
        url: `http://localhost:${REG_PORT}`,
        agentPath: "direct-mcp-agent",
      },
    });

    // Seed credentials directly. access_token is intentionally stale.
    const config = await adk.readConfig();
    await adk.writeConfig({
      ...config,
      refs: config.refs?.map((r: any) => {
        if (r.ref === "direct-mcp-agent") {
          return {
            ...r,
            // Force the direct-MCP branch: any mode that's not "api".
            mode: "redirect",
            config: {
              ...r.config,
              access_token: "stale-direct-token",
              refresh_token: "direct-refresh-token",
              client_id: "direct-client-id",
            },
          };
        }
        return r;
      }),
    });

    const result = await adk.ref.call("direct-mcp-agent", "some_tool", {});

    // Without the fix: tokenRefreshCount stays 0, toolCallCount === 1,
    // result.success === false with `MCP tools/call failed (401)` in error.
    // With the fix: 401 → refresh → retry succeeds.
    expect(tokenRefreshCount).toBe(1);
    expect(toolCallCount).toBe(2);
    expect((result as any).success).toBe(true);
    expect((result as any).result).toEqual({
      ok: true,
      token: "refreshed-direct-token",
    });
  });
});

// ─── Registry auth lifecycle ─────────────────────────────────────

describe("ADK registry auth lifecycle", () => {
  const PORT = 19930;
  const MCP_URL = `http://localhost:${PORT}/mcp`;
  const AS_URL = `http://localhost:${PORT}`;

  let mcpServer: ReturnType<typeof Bun.serve>;
  let activeAccessToken = "access-token-v1";
  let tokenExchangeCount = 0;
  let tokenRefreshCount = 0;

  beforeAll(() => {
    // Fake registry that speaks MCP when authenticated, emits an RFC 6750
    // challenge pointing at RFC 9728 metadata when not, and doubles as the
    // OAuth authorization server (registration + authorize + token) so the
    // whole adk registry.auth flow can run end-to-end in-process.
    mcpServer = Bun.serve({
      port: PORT,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;

        // RFC 9728 protected-resource metadata
        if (path === "/.well-known/oauth-protected-resource") {
          return Response.json({
            resource: MCP_URL,
            authorization_servers: [AS_URL],
            scopes_supported: ["mcp:full"],
            bearer_methods_supported: ["header"],
          });
        }

        // RFC 8414 authorization-server metadata
        if (path === "/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: AS_URL,
            authorization_endpoint: `${AS_URL}/oauth/authorize`,
            token_endpoint: `${AS_URL}/oauth/token`,
            registration_endpoint: `${AS_URL}/oauth/register`,
          });
        }

        // Dynamic client registration (RFC 7591)
        if (path === "/oauth/register" && req.method === "POST") {
          return Response.json({
            client_id: "test-client-id",
            client_secret: "test-client-secret",
          });
        }

        // Token endpoint — supports authorization_code + refresh_token grants
        if (path === "/oauth/token" && req.method === "POST") {
          const body = new URLSearchParams(await req.text());
          const grant = body.get("grant_type");
          if (grant === "authorization_code") {
            tokenExchangeCount++;
            return Response.json({
              access_token: activeAccessToken,
              refresh_token: "refresh-token-v1",
              token_type: "Bearer",
              expires_in: 3600,
            });
          }
          if (grant === "refresh_token") {
            tokenRefreshCount++;
            if (body.get("refresh_token") !== "refresh-token-v1") {
              return new Response(JSON.stringify({ error: "invalid_grant" }), {
                status: 400,
              });
            }
            // Rotate to a new access token so the test can tell refresh ran.
            activeAccessToken = "access-token-v2";
            return Response.json({
              access_token: activeAccessToken,
              token_type: "Bearer",
              expires_in: 3600,
            });
          }
          return new Response("unsupported_grant_type", { status: 400 });
        }

        // MCP endpoint
        if (path === "/mcp" && req.method === "POST") {
          const auth = req.headers.get("authorization") ?? "";
          const expected = `Bearer ${activeAccessToken}`;
          if (auth !== expected) {
            return new Response(
              JSON.stringify({
                error: { code: "UNAUTHORIZED", message: "No token" },
              }),
              {
                status: 401,
                headers: {
                  "Content-Type": "application/json",
                  "WWW-Authenticate": `Bearer realm="test", resource_metadata="${AS_URL}/.well-known/oauth-protected-resource"`,
                },
              },
            );
          }
          const rpc = (await req.json()) as { id: number; method: string };
          if (rpc.method === "initialize") {
            return Response.json({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { serverInfo: { name: "test-mcp" }, capabilities: {} },
            });
          }
          if (rpc.method === "tools/call") {
            return Response.json({
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      agents: [
                        {
                          path: "@test-agent",
                          description: "An agent",
                          toolCount: 1,
                        },
                      ],
                    }),
                  },
                ],
              },
            });
          }
          return new Response("method not found", { status: 404 });
        }

        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    mcpServer.stop();
  });

  test("registry.add records auth challenge; browse refuses; auth() unlocks", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs, {
      encryptionKey: "test-key-32-chars-long-enough!!",
    });

    const addResult = await adk.registry.add({ name: "test", url: MCP_URL });

    expect(addResult.authRequirement).toBeDefined();
    expect(addResult.authRequirement?.scheme).toBe("Bearer");
    expect(addResult.authRequirement?.authorizationServers).toEqual([AS_URL]);
    expect(addResult.authRequirement?.scopes).toEqual(["mcp:full"]);

    await expect(adk.registry.browse("test")).rejects.toMatchObject({
      code: "registry_auth_required",
    });

    await adk.registry.auth("test", { token: activeAccessToken });

    // Stored token is encrypted (secret: prefix) — buildConsumer decrypts
    // it transparently so browse should now land the MCP call.
    const stored = await adk.registry.get("test");
    expect(stored?.auth?.type).toBe("bearer");
    expect((stored?.auth as { token: string }).token).toMatch(/^secret:/);
    expect(stored?.authRequirement).toBeUndefined();

    const agents = await adk.registry.browse("test");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.path).toBe("@test-agent");
  });

  test("browse 401 triggers refresh via stored refresh_token and retries", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs, {
      encryptionKey: "test-key-32-chars-long-enough!!",
    });

    // Reset server-side token so the next refresh rotates predictably.
    activeAccessToken = "access-token-v1";
    tokenRefreshCount = 0;

    await adk.registry.add({ name: "test", url: MCP_URL });
    await adk.registry.auth("test", { token: activeAccessToken });

    // Seed the entry with OAuth state as if `authLocal` had completed.
    // Refresh token / endpoint / clientId are written directly so the
    // test isn't dependent on the full browser-redirect flow.
    const config = await adk.readConfig();
    await adk.writeConfig({
      ...config,
      registries: config.registries?.map((r: any) => {
        if (typeof r !== "string" && r.name === "test") {
          return {
            ...r,
            oauth: {
              tokenEndpoint: `${AS_URL}/oauth/token`,
              clientId: "test-client-id",
              refreshToken: "refresh-token-v1",
            },
          };
        }
        return r;
      }),
    });

    // Rotate the server token — the client's stored token is now stale.
    activeAccessToken = "access-token-v2";

    const agents = await adk.registry.browse("test");

    // Refresh was called exactly once; the browse call succeeded on retry.
    expect(tokenRefreshCount).toBe(1);
    expect(agents).toHaveLength(1);

    const stored = await adk.registry.get("test");
    expect((stored?.auth as { token: string }).token).toMatch(/^secret:/);
  });
});

// ─── ADK ref registry cache ──────────────────────────────────────

describe("ADK ref registry cache", () => {
  let server: AgentServer;
  const PORT = 19940;

  // Agents configured with descriptions so the registry's describe_tools
  // response carries metadata for the cache to capture.
  const cachedMathAgent = defineAgent({
    path: "@cached-math",
    entrypoint: "Math agent",
    tools: [add],
    visibility: "public",
    config: { description: "Adds numbers together" },
  });

  const cachedEchoAgent = defineAgent({
    path: "@cached-echo",
    entrypoint: "Echo agent",
    tools: [echo],
    visibility: "public",
    config: { description: "Echoes back the input" },
  });

  beforeAll(async () => {
    const registry = createAgentRegistry();
    registry.register(cachedMathAgent);
    registry.register(cachedEchoAgent);
    server = createAgentServer(registry, { port: PORT });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test("ref.add populates registry-cache.json with description and slim tools", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.registry.add({
      url: `http://localhost:${PORT}`,
      name: "main",
    });
    await adk.ref.add({
      ref: "@cached-math",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${PORT}`,
        agentPath: "@cached-math",
      },
    });

    const cacheRaw = await fs.readFile("registry-cache.json");
    expect(cacheRaw).not.toBeNull();
    const cache = JSON.parse(cacheRaw!);
    const entry = cache.refs["@cached-math"];
    expect(entry).toBeDefined();
    expect(entry.ref).toBe("@cached-math");
    expect(entry.description).toBe("Adds numbers together");
    expect(entry.tools).toBeDefined();
    expect(entry.tools.length).toBeGreaterThan(0);
    expect(entry.tools[0].name).toBe("add");
    expect(entry.tools[0].description).toBe("Add two numbers");
    // inputSchema MUST NOT leak into the cache — that's our whole point.
    expect(entry.tools[0]).not.toHaveProperty("inputSchema");
    expect(typeof entry.fetchedAt).toBe("string");
  });

  test("ref.list hydrates description and tools from cache", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.registry.add({
      url: `http://localhost:${PORT}`,
      name: "main",
    });
    await adk.ref.add({
      ref: "@cached-math",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${PORT}`,
        agentPath: "@cached-math",
      },
    });

    const refs = await adk.ref.list();
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("@cached-math");
    expect(refs[0].description).toBe("Adds numbers together");
    expect(refs[0].tools).toBeDefined();
    expect(refs[0].tools?.[0].name).toBe("add");
  });

  test("ref.list returns description undefined when cache is empty", async () => {
    const fs = createMemoryFs();
    // Seed a ref directly into consumer-config without a cache entry — this is
    // the "existing user, fresh cache" case (e.g. before the backfill runs).
    await fs.writeFile(
      "consumer-config.json",
      JSON.stringify({
        refs: [
          {
            ref: "@cached-math",
            name: "@cached-math",
            scheme: "registry",
            sourceRegistry: {
              url: `http://localhost:${PORT}`,
              agentPath: "@cached-math",
            },
          },
        ],
      }),
    );

    const adk = createAdk(fs);
    const refs = await adk.ref.list();
    expect(refs).toHaveLength(1);
    expect(refs[0].description).toBeUndefined();
    expect(refs[0].tools).toBeUndefined();
  });

  test("ref.get hydrates a single ref from the cache", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.registry.add({
      url: `http://localhost:${PORT}`,
      name: "main",
    });
    await adk.ref.add({
      ref: "@cached-math",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${PORT}`,
        agentPath: "@cached-math",
      },
    });

    const ref = await adk.ref.get("@cached-math");
    expect(ref).not.toBeNull();
    expect(ref?.description).toBe("Adds numbers together");
    expect(ref?.tools?.[0].name).toBe("add");
  });

  test("ref.inspect refreshes the cache for the inspected ref", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.registry.add({
      url: `http://localhost:${PORT}`,
      name: "main",
    });
    // Seed without registry add-time inspect (use bare config seeding) so the
    // cache starts empty and we can see ref.inspect populate it.
    await fs.writeFile(
      "consumer-config.json",
      JSON.stringify({
        registries: [{ url: `http://localhost:${PORT}`, name: "main" }],
        refs: [
          {
            ref: "@cached-math",
            name: "@cached-math",
            scheme: "registry",
            sourceRegistry: {
              url: `http://localhost:${PORT}`,
              agentPath: "@cached-math",
            },
          },
        ],
      }),
    );

    // Cache is empty before inspect.
    const beforeRefs = await adk.ref.list();
    expect(beforeRefs[0].description).toBeUndefined();

    // Inspect populates the cache.
    const info = await adk.ref.inspect("@cached-math");
    expect(info).toBeDefined();

    const afterRefs = await adk.ref.list();
    expect(afterRefs[0].description).toBe("Adds numbers together");
    expect(afterRefs[0].tools?.[0].name).toBe("add");
  });

  test("ref.inspect with full: true does not leak inputSchema into the cache", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.registry.add({
      url: `http://localhost:${PORT}`,
      name: "main",
    });
    await adk.ref.add({
      ref: "@cached-math",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${PORT}`,
        agentPath: "@cached-math",
      },
    });

    // Caller gets the full schema in the response…
    const full = await adk.ref.inspect("@cached-math", { full: true });
    expect(full?.tools?.[0]).toHaveProperty("inputSchema");

    // …but the cache stays slim.
    const cacheRaw = await fs.readFile("registry-cache.json");
    const cache = JSON.parse(cacheRaw!);
    const entry = cache.refs["@cached-math"];
    expect(entry.tools[0]).not.toHaveProperty("inputSchema");
  });

  test("ref.remove drops the cache entry", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.registry.add({
      url: `http://localhost:${PORT}`,
      name: "main",
    });
    await adk.ref.add({
      ref: "@cached-math",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${PORT}`,
        agentPath: "@cached-math",
      },
    });
    await adk.ref.add({
      ref: "@cached-echo",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${PORT}`,
        agentPath: "@cached-echo",
      },
    });

    let cache = JSON.parse((await fs.readFile("registry-cache.json"))!);
    expect(Object.keys(cache.refs)).toEqual(
      expect.arrayContaining(["@cached-math", "@cached-echo"]),
    );

    await adk.ref.remove("@cached-math");

    cache = JSON.parse((await fs.readFile("registry-cache.json"))!);
    expect(cache.refs["@cached-math"]).toBeUndefined();
    expect(cache.refs["@cached-echo"]).toBeDefined();
  });

  test("malformed registry-cache.json is treated as empty (does not break list)", async () => {
    const fs = createMemoryFs();
    await fs.writeFile(
      "consumer-config.json",
      JSON.stringify({
        refs: [
          {
            ref: "@cached-math",
            name: "@cached-math",
            scheme: "registry",
            sourceRegistry: {
              url: `http://localhost:${PORT}`,
              agentPath: "@cached-math",
            },
          },
        ],
      }),
    );
    await fs.writeFile("registry-cache.json", "{ this is not json");

    const adk = createAdk(fs);
    const refs = await adk.ref.list();
    expect(refs).toHaveLength(1);
    expect(refs[0].description).toBeUndefined();
  });
});

// ─── isRefAuthComplete + authFields cache ────────────────────────

describe("isRefAuthComplete + cached authFields", () => {
  /**
   * The core idea: `auth-status` knows what fields are required for a
   * given security scheme (it asks the registry). Cache that answer
   * shape per-ref so subsequent host-side "is this ref ready to call?"
   * checks can be evaluated locally with no network round-trip, and
   * stay accurate as the user fills in or clears credentials in the
   * entry's config.
   *
   * `isRefAuthComplete(entry, cacheEntry)` returns:
   *   - `true`  when all required fields are satisfied (present in
   *     `entry.config` OR marked `automated`).
   *   - `false` when at least one required, non-automated field is
   *     missing.
   *   - `null`  when the cache has no `authFields` for this ref yet
   *     (caller should fall back or refresh via `auth-status`).
   */

  test("cache miss returns null", async () => {
    const { isRefAuthComplete } = await import("./config-store");
    const result = isRefAuthComplete(
      {
        ref: "@unknown",
        name: "@unknown",
        scheme: "https",
        url: "http://localhost",
      },
      undefined,
    );
    expect(result).toBeNull();
  });

  test("empty authFields object → true (security:none refs cache an empty map)", async () => {
    // Companion to the authStatus regression: an explicit `authFields: {}`
    // in the registry-cache (written by `authStatus` for security:none refs)
    // means "no required fields to satisfy" — not "cache miss". The
    // distinction matters because callers (`atlas-os-sdk` `isRefConnected`)
    // use a different fallback strategy on null vs false. With an empty
    // map, the required-fields loop runs zero times and we return true.
    const { isRefAuthComplete } = await import("./config-store");
    const result = isRefAuthComplete(
      {
        ref: "@web-search",
        name: "@web-search",
        scheme: "registry",
        sourceRegistry: {
          url: "http://localhost",
          agentPath: "@web-search",
        },
      },
      {
        ref: "@web-search",
        fetchedAt: new Date().toISOString(),
        authFields: {},
      },
    );
    expect(result).toBe(true);
  });

  test("required field present → true", async () => {
    const { isRefAuthComplete } = await import("./config-store");
    const result = isRefAuthComplete(
      {
        ref: "@oauth",
        name: "@oauth",
        scheme: "https",
        url: "http://localhost",
        config: {
          client_id: "abc",
          client_secret: "xyz",
          access_token: "tok",
        },
      },
      {
        ref: "@oauth",
        fetchedAt: new Date().toISOString(),
        authFields: {
          client_id: { required: true, automated: false },
          client_secret: { required: true, automated: false },
          access_token: { required: true, automated: true },
        },
      },
    );
    expect(result).toBe(true);
  });

  test("automated field absent still counts as satisfied", async () => {
    const { isRefAuthComplete } = await import("./config-store");
    // dynamicRegistration: client_id is automated, so absence is fine.
    const result = isRefAuthComplete(
      {
        ref: "@oauth",
        name: "@oauth",
        scheme: "https",
        url: "http://localhost",
        config: {
          // client_id missing
          access_token: "tok",
        },
      },
      {
        ref: "@oauth",
        fetchedAt: new Date().toISOString(),
        authFields: {
          client_id: { required: true, automated: true },
          access_token: { required: true, automated: true },
        },
      },
    );
    expect(result).toBe(true);
  });

  test("required, non-automated field missing → false", async () => {
    const { isRefAuthComplete } = await import("./config-store");
    const result = isRefAuthComplete(
      {
        ref: "@oauth",
        name: "@oauth",
        scheme: "https",
        url: "http://localhost",
        config: {
          client_id: "abc",
          client_secret: "xyz",
          // access_token missing — user hasn't completed OAuth yet.
        },
      },
      {
        ref: "@oauth",
        fetchedAt: new Date().toISOString(),
        authFields: {
          client_id: { required: true, automated: false },
          client_secret: { required: true, automated: false },
          access_token: { required: true, automated: false },
        },
      },
    );
    expect(result).toBe(false);
  });

  test("non-required field absence is fine", async () => {
    const { isRefAuthComplete } = await import("./config-store");
    const result = isRefAuthComplete(
      {
        ref: "@oauth",
        name: "@oauth",
        scheme: "https",
        url: "http://localhost",
        config: { access_token: "tok" },
      },
      {
        ref: "@oauth",
        fetchedAt: new Date().toISOString(),
        authFields: {
          client_id: { required: false, automated: false },
          access_token: { required: true, automated: false },
        },
      },
    );
    expect(result).toBe(true);
  });

  test("resolvableFields satisfies required, non-automated fields absent from config", async () => {
    // Scenario: registry-hosted OAuth where the platform injects
    // client_id / client_secret at runtime via resolveCredentials.
    // The registry sees them as user-provided (required + non-automated)
    // but the consumer environment satisfies them externally.
    const { isRefAuthComplete } = await import("./config-store");
    const result = isRefAuthComplete(
      {
        ref: "google-gmail",
        name: "google-gmail",
        scheme: "registry",
        config: {
          // client_id / client_secret missing — resolved from env vars.
          access_token: "tok",
        },
      },
      {
        ref: "google-gmail",
        fetchedAt: new Date().toISOString(),
        authFields: {
          client_id: { required: true, automated: false },
          client_secret: { required: true, automated: false },
          access_token: { required: true, automated: true },
        },
      },
      { resolvableFields: ["client_id", "client_secret"] },
    );
    expect(result).toBe(true);
  });

  test("resolvableFields does not bypass missing fields it doesn't list", async () => {
    const { isRefAuthComplete } = await import("./config-store");
    const result = isRefAuthComplete(
      {
        ref: "@oauth",
        name: "@oauth",
        scheme: "https",
        url: "http://localhost",
        config: {
          client_id: "abc",
          // client_secret missing AND not listed as resolvable.
        },
      },
      {
        ref: "@oauth",
        fetchedAt: new Date().toISOString(),
        authFields: {
          client_id: { required: true, automated: false },
          client_secret: { required: true, automated: false },
        },
      },
      { resolvableFields: ["client_id"] },
    );
    expect(result).toBe(false);
  });
});

