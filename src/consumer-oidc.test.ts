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
  inputSchema: { type: "object", properties: {} },
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

// ─── E2E: Full OIDC Sign-In Flow ────────────────────────────
//
// Real flow, no shortcuts:
//   1. GET /signin/authorize?redirect_uri=...  →  302 to mock OIDC
//   2. Mock OIDC /authorize                    →  302 back with code
//   3. GET /signin/callback?code=...&state=... →  server exchanges code,
//      fetches userinfo, signs JWT             →  302 to redirect_uri?token=JWT
//   4. Consumer uses JWT to access agents

describe("OIDC Sign-In Flow", () => {
  let oidc: MockOIDCServer;
  let server: AgentServer;
  const REGISTRY_PORT = 19893;
  const ROOT_KEY = "test-root-key-oidc";

  beforeAll(async () => {
    // Start mock OIDC provider
    oidc = await startMockOIDC({ port: 19894 });

    // Start registry with OIDC sign-in configured
    const registry = createAgentRegistry();
    registry.register(
      createAuthAgent({ rootKey: ROOT_KEY, allowRegistration: true }),
    );
    registry.register(internalAgent);
    registry.register(publicAgent);

    server = createAgentServer(registry, {
      port: REGISTRY_PORT,
      oidcProvider: {
        issuer: oidc.issuer,
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
      },
    });
    await server.initKeys();
    await server.start();
  });

  afterAll(async () => {
    await server?.stop?.();
    await oidc?.stop();
  });

  async function performOIDCSignIn(): Promise<string> {
    const baseUrl = `http://localhost:${REGISTRY_PORT}`;
    const myAppCallback = "http://localhost:9999/my-app/done";

    // Step 1: Hit /signin/authorize — should 302 to OIDC provider
    const authorizeRes = await fetch(
      `${baseUrl}/signin/authorize?redirect_uri=${encodeURIComponent(myAppCallback)}`,
      { redirect: "manual" },
    );
    expect(authorizeRes.status).toBe(302);

    const idpUrl = new URL(authorizeRes.headers.get("location")!);
    expect(idpUrl.origin).toBe(oidc.url);
    expect(idpUrl.pathname).toBe("/authorize");
    expect(idpUrl.searchParams.get("client_id")).toBe(oidc.clientId);
    expect(idpUrl.searchParams.get("response_type")).toBe("code");

    const state = idpUrl.searchParams.get("state")!;
    const callbackUri = idpUrl.searchParams.get("redirect_uri")!;
    expect(state).toBeTruthy();
    expect(callbackUri).toContain("/signin/callback");

    // Step 2: Hit the OIDC provider's authorize — it immediately redirects back with code
    const oidcAuthorizeRes = await fetch(idpUrl.toString(), { redirect: "manual" });
    expect(oidcAuthorizeRes.status).toBe(302);

    const callbackRedirect = new URL(oidcAuthorizeRes.headers.get("location")!);
    expect(callbackRedirect.searchParams.get("code")).toBeTruthy();
    expect(callbackRedirect.searchParams.get("state")).toBe(state);

    // Step 3: Hit /signin/callback with the code — server exchanges code, fetches userinfo, signs JWT
    const callbackRes = await fetch(callbackRedirect.toString(), { redirect: "manual" });
    expect(callbackRes.status).toBe(302);

    const finalRedirect = new URL(callbackRes.headers.get("location")!);
    expect(finalRedirect.origin).toBe("http://localhost:9999");
    expect(finalRedirect.pathname).toBe("/my-app/done");

    const jwt = finalRedirect.searchParams.get("token")!;
    expect(jwt).toBeTruthy();
    expect(jwt.split(".")).toHaveLength(3);

    return jwt;
  }

  test("full OIDC flow returns valid JWT", async () => {
    const jwt = await performOIDCSignIn();

    // Decode and verify claims
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString(),
    );
    expect(payload.sub).toBe("test-user-001");
    expect(payload.email).toBe("test@example.com");
    expect(payload.name).toBe("Test User");
    expect(payload.provider).toBe("oidc");
    expect(payload.oidc_issuer).toBe(oidc.issuer);
    expect(payload.iss).toBeTruthy();
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000);
  });

  test("JWT from OIDC flow can list all agents", async () => {
    const jwt = await performOIDCSignIn();

    const consumer = await createRegistryConsumer(
      { registries: [`http://localhost:${REGISTRY_PORT}`] },
      { token: jwt },
    );

    const agents = await consumer.list();
    const paths = agents.map((a) => a.path);
    expect(paths).toContain("@secrets");
    expect(paths).toContain("@public");
  });

  test("JWT from OIDC flow can call internal agent", async () => {
    const jwt = await performOIDCSignIn();

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

  test("/signin/authorize without redirect_uri returns 400", async () => {
    const res = await fetch(
      `http://localhost:${REGISTRY_PORT}/signin/authorize`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("/signin/callback with bad state returns 400", async () => {
    const res = await fetch(
      `http://localhost:${REGISTRY_PORT}/signin/callback?code=fake&state=bogus`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_state");
  });

  test(".well-known/configuration includes signin_endpoint", async () => {
    const res = await fetch(
      `http://localhost:${REGISTRY_PORT}/.well-known/configuration`,
    );
    const config = (await res.json()) as Record<string, unknown>;
    expect(config.signin_endpoint).toBe(
      `http://localhost:${REGISTRY_PORT}/signin/authorize`,
    );
  });
});
