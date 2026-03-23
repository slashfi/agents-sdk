import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  createAgentServer,
  createAgentRegistry,
  generateSigningKey,
  signJwtES256,
  detectAuth,
  canSeeAgent,
} from './index';
import type { AgentDefinition, AgentServer, SigningKey } from './index';

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

// ─── E2E: Two real servers communicating ─────────────────────────
//
// Server B (the "issuer") generates its own signing key via the SDK,
// serves JWKS at /.well-known/jwks.json, and produces service tokens.
//
// Server A (the "consumer") trusts Server B as an issuer. When Server A
// receives a Bearer token, it fetches Server B's JWKS endpoint and
// verifies the signature through the real resolveAuth pipeline.
//
// No test helpers, no mock JWKS, no hand-rolled signToken.
// Both servers use the SDK's own crypto and auth infrastructure.

describe('E2E: two createAgentServers with cross-registry trust', () => {
  const PORT_A = 19900; // consumer
  const PORT_B = 19901; // issuer

  let serverA: AgentServer;
  let serverB: AgentServer;
  let serverBSigningKey: SigningKey;

  beforeAll(async () => {
    // ── Server B: the issuer ──
    // Generates its own ES256 key, serves JWKS, acts as the token source.
    serverBSigningKey = await generateSigningKey('server-b-key');

    const registryB = createAgentRegistry();
    registryB.register(makeAgent('/agents/@ticker', { visibility: 'internal' }));

    serverB = createAgentServer(registryB, {
      port: PORT_B,
      signingKey: serverBSigningKey,
    });
    await serverB.start();

    // ── Server A: the consumer ──
    // Trusts Server B's URL as a trusted issuer with agents:admin scopes.
    // NO @auth agent registered — this is the exact scenario that broke.
    const registryA = createAgentRegistry();
    registryA.register(makeAgent('/agents/@clock', { visibility: 'internal' }));
    registryA.register(makeAgent('/agents/public-bot', { visibility: 'public' }));
    registryA.register(makeAgent('/agents/@secret-agent', { visibility: 'private' }));

    serverA = createAgentServer(registryA, {
      port: PORT_A,
      trustedIssuers: [{
        issuer: `http://localhost:${PORT_B}`,
        scopes: ['agents:admin'],
      }],
    });
    await serverA.start();
  });

  afterAll(async () => {
    await serverA?.stop();
    await serverB?.stop();
  });

  // Helper: Server B signs a service token using its own key (the SDK's signJwtES256)
  async function serverBServiceToken(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    return signJwtES256(
      {
        sub: 'server-b',
        name: 'Server B',
        scopes: ['agents:admin'],
        ...overrides,
      } as any,
      serverBSigningKey.privateKey,
      serverBSigningKey.kid,
      `http://localhost:${PORT_B}`, // iss matches the trusted issuer URL
      '5m',
    );
  }

  // ─── Core auth flow: token from Server B → Server A grants access ───

  test('Server B token → Server A grants access to internal agent', async () => {
    const token = await serverBServiceToken();
    const rpc = await mcpCall(PORT_A, 'call_agent', {
      request: { action: 'load', path: '/agents/@clock' },
    }, token);

    const result = parseResult(rpc);
    expect(result.success).toBe(true);
  });

  test('no token → Server A denies internal agent', async () => {
    const rpc = await mcpCall(PORT_A, 'call_agent', {
      request: { action: 'load', path: '/agents/@clock' },
    });

    const result = parseResult(rpc);
    expect(result.success).toBe(false);
    expect(result.code).toBe('ACCESS_DENIED');
  });

  test('no token → public agent still accessible on Server A', async () => {
    const rpc = await mcpCall(PORT_A, 'call_agent', {
      request: { action: 'load', path: '/agents/public-bot' },
    });

    const result = parseResult(rpc);
    expect(result.success).toBe(true);
  });

  test('garbage token → Server A denies access', async () => {
    const rpc = await mcpCall(PORT_A, 'call_agent', {
      request: { action: 'load', path: '/agents/@clock' },
    }, 'not.a.valid.jwt');

    const result = parseResult(rpc);
    expect(result.success).toBe(false);
    expect(result.code).toBe('ACCESS_DENIED');
  });

  test('token from unknown issuer → Server A denies access', async () => {
    // Generate a completely separate key (simulating an untrusted server)
    const rogueKey = await generateSigningKey('rogue-key');
    const rogueToken = await signJwtES256(
      { sub: 'rogue', name: 'Rogue', scopes: ['agents:admin'] } as any,
      rogueKey.privateKey,
      rogueKey.kid,
      'http://localhost:29999', // not in Server A's trustedIssuers
      '5m',
    );

    const rpc = await mcpCall(PORT_A, 'call_agent', {
      request: { action: 'load', path: '/agents/@clock' },
    }, rogueToken);

    const result = parseResult(rpc);
    expect(result.success).toBe(false);
    expect(result.code).toBe('ACCESS_DENIED');
  });

  test('token with correct issuer URL but wrong signing key → Server A denies', async () => {
    // Spoofed: claims to be from Server B but signed with a different key
    const spoofKey = await generateSigningKey('spoof-key');
    const spoofToken = await signJwtES256(
      { sub: 'spoof', name: 'Spoof', scopes: ['agents:admin'] } as any,
      spoofKey.privateKey,
      spoofKey.kid,
      `http://localhost:${PORT_B}`, // claims Server B as issuer
      '5m',
    );

    const rpc = await mcpCall(PORT_A, 'call_agent', {
      request: { action: 'load', path: '/agents/@clock' },
    }, spoofToken);

    const result = parseResult(rpc);
    expect(result.success).toBe(false);
    expect(result.code).toBe('ACCESS_DENIED');
  });

  // ─── Visibility in list_agents ─────────────────────────────────

  test('list_agents without token → only public agents visible', async () => {
    const rpc = await mcpCall(PORT_A, 'list_agents', {});
    const result = parseResult(rpc);
    expect(result.success).toBe(true);

    const paths = result.agents.map((a: any) => a.path);
    expect(paths).toContain('/agents/public-bot');
    expect(paths).not.toContain('/agents/@clock');
    expect(paths).not.toContain('/agents/@secret-agent');
  });

  test('list_agents with Server B token → all agents visible (system)', async () => {
    const token = await serverBServiceToken();
    const rpc = await mcpCall(PORT_A, 'list_agents', {}, token);
    const result = parseResult(rpc);
    expect(result.success).toBe(true);

    const paths = result.agents.map((a: any) => a.path);
    expect(paths).toContain('/agents/public-bot');
    expect(paths).toContain('/agents/@clock');
  });

  // ─── JWKS endpoint verification ────────────────────────────────

  test('Server B serves valid JWKS at /.well-known/jwks.json', async () => {
    const res = await fetch(`http://localhost:${PORT_B}/.well-known/jwks.json`);
    expect(res.ok).toBe(true);

    const jwks = await res.json() as { keys: any[] };
    expect(jwks.keys).toBeArrayOfSize(1);
    expect(jwks.keys[0].kid).toBe('server-b-key');
    expect(jwks.keys[0].alg).toBe('ES256');
    // Must NOT contain private key material
    expect(jwks.keys[0].d).toBeUndefined();
  });

  test('Server A serves its own JWKS (auto-generated key)', async () => {
    const res = await fetch(`http://localhost:${PORT_A}/.well-known/jwks.json`);
    expect(res.ok).toBe(true);

    const jwks = await res.json() as { keys: any[] };
    expect(jwks.keys.length).toBeGreaterThanOrEqual(1);
    expect(jwks.keys[0].alg).toBe('ES256');
    expect(jwks.keys[0].d).toBeUndefined();
  });
});

// ─── E2E: Limited scopes (non-admin issuer) ──────────────────────

describe('E2E: limited-scope trusted issuer', () => {
  const PORT_CONSUMER = 19902;
  const PORT_ISSUER = 19903;

  let consumer: AgentServer;
  let issuer: AgentServer;
  let issuerKey: SigningKey;

  beforeAll(async () => {
    issuerKey = await generateSigningKey('limited-issuer-key');

    const issuerRegistry = createAgentRegistry();
    issuerRegistry.register(makeAgent('/agents/@issuer-agent'));
    issuer = createAgentServer(issuerRegistry, {
      port: PORT_ISSUER,
      signingKey: issuerKey,
    });
    await issuer.start();

    const consumerRegistry = createAgentRegistry();
    consumerRegistry.register(makeAgent('/agents/@internal-agent', { visibility: 'internal' }));
    consumerRegistry.register(makeAgent('/agents/@private-agent', { visibility: 'private' }));
    consumerRegistry.register(makeAgent('/agents/open-agent', { visibility: 'public' }));

    consumer = createAgentServer(consumerRegistry, {
      port: PORT_CONSUMER,
      trustedIssuers: [{
        issuer: `http://localhost:${PORT_ISSUER}`,
        scopes: ['agents:read'], // NOT agents:admin or *
      }],
    });
    await consumer.start();
  });

  afterAll(async () => {
    await consumer?.stop();
    await issuer?.stop();
  });

  async function issuerToken(): Promise<string> {
    return signJwtES256(
      { sub: 'limited-svc', name: 'Limited Service', scopes: ['agents:read'] } as any,
      issuerKey.privateKey,
      issuerKey.kid,
      `http://localhost:${PORT_ISSUER}`,
      '5m',
    );
  }

  test('limited scopes → can access internal agents (agent-level)', async () => {
    const token = await issuerToken();
    const rpc = await mcpCall(PORT_CONSUMER, 'call_agent', {
      request: { action: 'load', path: '/agents/@internal-agent' },
    }, token);

    const result = parseResult(rpc);
    expect(result.success).toBe(true);
  });

  test('limited scopes → cannot access private agents', async () => {
    const token = await issuerToken();
    const rpc = await mcpCall(PORT_CONSUMER, 'call_agent', {
      request: { action: 'load', path: '/agents/@private-agent' },
    }, token);

    const result = parseResult(rpc);
    expect(result.success).toBe(false);
    expect(result.code).toBe('ACCESS_DENIED');
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
