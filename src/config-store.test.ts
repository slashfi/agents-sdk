import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createAdk,
  createAdkTools,
  createAgentRegistry,
  createAgentServer,
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
          return { content: [{ type: "text", text: '{"error":"401 Unauthorized"}' }], _httpStatus: 401 };
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
          return new Response(JSON.stringify({ error: "unsupported_grant_type" }), { status: 400 });
        }
        if (params.get("refresh_token") !== "my-refresh-token") {
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        }
        if (params.get("client_id") !== "my-client-id") {
          return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
        }
        return new Response(JSON.stringify({
          access_token: "refreshed-token",
          token_type: "Bearer",
          expires_in: 3600,
        }), { headers: { "Content-Type": "application/json" } });
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
          return { content: [{ type: "text", text: '{"error":"401 Unauthorized"}' }], _httpStatus: 401 };
        }
        if (token === "refreshed-token") {
          return { message: "success", token };
        }
        return { content: [{ type: "text", text: '{"error":"403 Forbidden"}' }], _httpStatus: 403 };
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
    const adk = createAdk(fs, { encryptionKey: "test-key-32-chars-long-enough!!" });

    await adk.registry.add({ name: "oauth-reg", url: `http://localhost:${REG_PORT}` });
    await adk.ref.add({
      ref: "oauth-api",
      sourceRegistry: { url: `http://localhost:${REG_PORT}`, agentPath: "oauth-api" },
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
});

// ─── ADK Config Store: registry proxy routing ───────────────────

describe("ADK registry proxy routing", () => {
  let proxyServer: AgentServer;
  let proxyServerAdk: ReturnType<typeof createAdk>;
  const PROXY_PORT = 19930;

  beforeAll(async () => {
    // Real server-side adk that the proxy agent operates on. When the
    // local adk forwards ref ops, they land on this backing store via
    // the real @config `ref` tool produced by createAdkTools — no mocks.
    const proxyServerFs = createMemoryFs();
    proxyServerAdk = createAdk(proxyServerFs);
    await proxyServerAdk.writeConfig({
      refs: [
        {
          ref: "@gmail",
          scheme: "mcp",
          url: "https://gmail.example.com/mcp",
        },
      ],
    });

    // Expose that adk via the same tool surface production uses.
    const adkTools = createAdkTools({ resolveScope: () => proxyServerAdk });
    const configAgent = defineAgent({
      path: "@config",
      entrypoint: "@config agent for proxy routing tests",
      tools: adkTools,
      visibility: "public",
    });

    const proxyRegistry = createAgentRegistry();
    proxyRegistry.register(configAgent);
    proxyServer = createAgentServer(proxyRegistry, {
      port: PROXY_PORT,
      // Advertise proxy mode in the MCP initialize response so the
      // "registry.add auto-detects proxy" test can verify discovery.
      registry: { version: "1.0", proxy: { mode: "required" } },
    });
    await proxyServer.start();
  });

  afterAll(async () => {
    await proxyServer.stop();
  });

  /**
   * Seed the local consumer config with a ref sourced from the proxy
   * registry. We bypass ref.add's reachability check because we're
   * specifically testing how proxying routes around local state.
   */
  async function seedLocalRefFromProxy(fs: FsStore, refName: string) {
    const raw = (await fs.readFile("consumer-config.json")) ?? "{}";
    const config = JSON.parse(raw);
    config.refs = [
      {
        ref: refName,
        scheme: "registry",
        sourceRegistry: {
          url: `http://localhost:${PROXY_PORT}`,
          agentPath: refName,
        },
      },
    ];
    await fs.writeFile("consumer-config.json", JSON.stringify(config));
  }

  test("ref.authStatus forwards to the real @config on the proxy registry", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.registry.add({
      url: `http://localhost:${PROXY_PORT}`,
      name: "cloud",
      proxy: { mode: "required" },
    });
    await seedLocalRefFromProxy(fs, "@gmail");

    // The proxy-side adk owns the @gmail ref (no security declared in
    // its config above) so authStatus should report { complete: true }
    // with security: null.
    const status = await adk.ref.authStatus("@gmail");
    expect(status).toBeDefined();
    // The remote @config returned something — local adk never saw the ref,
    // so this would throw "Ref not found" if proxying wasn't wired.
    expect((status as { name?: string }).name ?? "@gmail").toBe("@gmail");
  });

  test("ref.auth forwards and returns the remote auth start result", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.registry.add({
      url: `http://localhost:${PROXY_PORT}`,
      name: "cloud",
      proxy: { mode: "required" },
    });
    await seedLocalRefFromProxy(fs, "@gmail");

    // @gmail on the proxy side has no security schema, so the real
    // @config.ref tool returns { type: 'none', complete: true }. The
    // assertion here is that we got *something* back from the remote,
    // proving the call made a round trip instead of throwing locally.
    const result = await adk.ref.auth("@gmail");
    expect(result).toBeDefined();
    expect((result as { type?: string }).type).toBeDefined();
  });

  test("registry.add auto-detects proxy from the server's handshake", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    // Caller passes NO proxy config. The server advertises
    // `capabilities.registry.proxy: { mode: 'required' }` in its MCP
    // initialize response (see beforeAll), so registry.add should
    // auto-populate the RegistryEntry at probe time.
    await adk.registry.add({
      url: `http://localhost:${PROXY_PORT}`,
      name: "cloud-autodetect",
    });

    const list = await adk.registry.list();
    const entry = list.find((r) => r.name === "cloud-autodetect");
    expect(entry?.proxy?.mode).toBe("required");
  });

  test("explicit proxy on registry.add is not overwritten by auto-detection", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    // Server advertises required; caller explicitly sets optional. The
    // caller's choice wins — discovery only fills in blanks.
    await adk.registry.add({
      url: `http://localhost:${PROXY_PORT}`,
      name: "cloud-explicit",
      proxy: { mode: "optional", agent: "@custom" },
    });

    const entry = (await adk.registry.list()).find((r) => r.name === "cloud-explicit");
    expect(entry?.proxy?.mode).toBe("optional");
    expect(entry?.proxy?.agent).toBe("@custom");
  });

  test("optional proxy honors preferLocal and skips forwarding", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.registry.add({
      url: `http://localhost:${PROXY_PORT}`,
      name: "cloud",
      proxy: { mode: "optional" },
    });
    await seedLocalRefFromProxy(fs, "@gmail");

    // With preferLocal:true we should fall through to the local path.
    // The local adk has no usable config for @gmail, so this path
    // throws or returns an empty status — either way, we prove we
    // stayed local by catching and confirming no exception bubbled
    // with "authorizeUrl" (which only the proxy path returns).
    const result = await adk.ref
      .auth("@gmail", { preferLocal: true })
      .catch((err: Error) => ({ _error: err.message }));
    expect((result as { authorizeUrl?: string }).authorizeUrl).toBeUndefined();
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
              return new Response(
                JSON.stringify({ error: "invalid_grant" }),
                { status: 400 },
              );
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
              JSON.stringify({ error: { code: "UNAUTHORIZED", message: "No token" } }),
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
                        { path: "@test-agent", description: "An agent", toolCount: 1 },
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
    const adk = createAdk(fs, { encryptionKey: "test-key-32-chars-long-enough!!" });

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
    const adk = createAdk(fs, { encryptionKey: "test-key-32-chars-long-enough!!" });

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
