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
