import { describe, test, expect, beforeAll, afterAll, mock, beforeEach } from 'bun:test';
import {
  createAgentServer,
  createAgentRegistry,
  createAuthAgent,
  defineTool,
} from './index';
import type { AgentServer, OAuthIdentityProvider } from './index';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

// ─── Helpers ─────────────────────────────────────────────────────

function parseResult(rpc: any): any {
  const text = rpc.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function postOAuthToken(
  port: number,
  body: Record<string, string>,
): Promise<any> {
  const res = await fetch(`http://localhost:${port}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function getOAuthAuthorize(
  port: number,
  params: Record<string, string>,
): Promise<{ status: number; location?: string; data?: any }> {
  const url = new URL(`http://localhost:${port}/oauth/authorize`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  
  const res = await fetch(url.toString(), { redirect: 'manual' });
  if (res.status === 302) {
    return { status: 302, location: res.headers.get('Location') ?? undefined };
  }
  return { status: res.status, data: await res.json() };
}

// ─── E2E: OAuth jwt_exchange + identity linking ──────────────────

describe('E2E: OAuth jwt_exchange flow', () => {
  // Registry (the caller) — has its own keypair
  let registryPrivateKey: CryptoKey;
  let registryPublicJwk: any;
  let registryJwksServer: ReturnType<typeof Bun.serve>;
  
  // Environments (the target) — the agent server under test
  let server: AgentServer;
  
  // Mock identity state (simulates DB)
  const linkedUsers = new Map<string, { atlasUserId: string; tenantId: string }>();
  const tenantLinks = new Map<string, string>(); // provider:foreignTenantId -> localTenantId
  
  // Mock OAuth identity provider
  let authorizeCallCount = 0;
  let callbackCallCount = 0;
  
  const JWKS_PORT = 19890;
  const SERVER_PORT = 19891;
  const REGISTRY_ISSUER = `http://localhost:${JWKS_PORT}`;
  const KID = 'registry-key-1';

  beforeAll(async () => {
    // 1. Generate registry keypair and serve JWKS
    const keyPair = await generateKeyPair('ES256', { extractable: true });
    registryPrivateKey = keyPair.privateKey;
    registryPublicJwk = await exportJWK(keyPair.publicKey);
    registryPublicJwk.kid = KID;
    registryPublicJwk.alg = 'ES256';
    registryPublicJwk.use = 'sig';

    registryJwksServer = Bun.serve({
      port: JWKS_PORT,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/.well-known/jwks.json') {
          return new Response(JSON.stringify({ keys: [registryPublicJwk] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      },
    });

    // 2. Create registry with @auth agent that has exchange_token overridden
    const registry = createAgentRegistry();
    
    const authAgent = createAuthAgent({
      allowRegistration: true,
    });
    registry.register(authAgent);

    // Override exchange_token with mock implementation
    const exchangeTokenTool = authAgent.tools.find((t: any) => t.name === 'exchange_token');
    if (exchangeTokenTool) {
      (exchangeTokenTool as any).execute = async (input: { token: string }) => {
        // Decode JWT to get claims (already verified by the tool caller)
        const parts = input.token.split('.');
        const claims = JSON.parse(atob(parts[1]));
        
        const issuer = claims.iss;
        const sub = claims.sub;
        const tenantId = claims.tenantId;

        // Resolve tenant (auto-create)
        const tenantKey = `${issuer}:${tenantId}`;
        if (!tenantLinks.has(tenantKey)) {
          tenantLinks.set(tenantKey, `local_tenant_${tenantLinks.size + 1}`);
        }
        const localTenantId = tenantLinks.get(tenantKey)!;

        // Resolve user
        const userKey = `${issuer}:${sub}`;
        if (linkedUsers.has(userKey)) {
          const user = linkedUsers.get(userKey)!;
          return {
            success: true,
            tenantId: localTenantId,
            userId: user.atlasUserId,
          };
        }

        // User not linked
        return {
          success: false,
          needsAuth: true,
          tenantId: localTenantId,
        };
      };
    }

    // 3. Mock OAuth identity provider
    const mockIdentityProvider: OAuthIdentityProvider = {
      async authorize(_req, params) {
        authorizeCallCount++;
        const { claims, redirectUri, baseUrl } = params;
        
        // If user already linked (check again), redirect back
        const userKey = `${claims.iss}:${claims.sub}`;
        if (linkedUsers.has(userKey)) {
          const redirect = new URL(redirectUri);
          redirect.searchParams.set('success', 'true');
          redirect.searchParams.set('atlas_user_id', linkedUsers.get(userKey)!.atlasUserId);
          return Response.redirect(redirect.toString(), 302);
        }
        
        // Redirect to "Slack" (mock: just redirect to callback with state)
        const callbackUrl = new URL(`${baseUrl}/oauth/callback`);
        callbackUrl.searchParams.set('code', 'mock_slack_code');
        callbackUrl.searchParams.set('state', JSON.stringify({
          iss: claims.iss,
          sub: claims.sub,
          tenantId: claims.tenantId,
          redirectUri,
        }));
        return Response.redirect(callbackUrl.toString(), 302);
      },

      async callback(req, _params) {
        callbackCallCount++;
        const url = new URL(req.url);
        const stateStr = url.searchParams.get('state');
        if (!stateStr) {
          return new Response(JSON.stringify({ error: 'missing_state' }), { status: 400 });
        }
        
        const state = JSON.parse(stateStr);
        
        // Simulate: Slack OAuth completed, found existing user, linking identity
        const atlasUserId = `atlas_user_${Date.now()}`;
        const userKey = `${state.iss}:${state.sub}`;
        linkedUsers.set(userKey, { atlasUserId, tenantId: state.tenantId });
        
        const redirect = new URL(state.redirectUri);
        redirect.searchParams.set('success', 'true');
        redirect.searchParams.set('atlas_user_id', atlasUserId);
        return Response.redirect(redirect.toString(), 302);
      },
    };

    // 4. Create agent server with trusted issuer + identity provider
    server = createAgentServer(registry, {
      port: SERVER_PORT,
      trustedIssuers: [{
        issuer: REGISTRY_ISSUER,
        scopes: ['agents:execute'],
      }],
      oauthIdentityProvider: mockIdentityProvider,
    });
    await server.start();
  });

  beforeEach(() => {
    authorizeCallCount = 0;
    callbackCallCount = 0;
  });

  afterAll(() => {
    server?.stop?.();
    registryJwksServer?.stop();
  });

  async function signRegistryJwt(claims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({
      sub: 'user_123',
      tenantId: 'tenant_abc',
      email: 'user@example.com',
      name: 'Test User',
      ...claims,
    } as any)
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuer(REGISTRY_ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(registryPrivateKey);
  }

  // ─── /oauth/token tests ────────────────────────────────────────

  describe('POST /oauth/token', () => {
    test('jwt_exchange: user not linked → identity_required', async () => {
      // Clear any linked users
      linkedUsers.clear();
      tenantLinks.clear();
      
      const jwt = await signRegistryJwt();
      const { status, data } = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: jwt,
        redirect_uri: 'http://registry.example.com/callback',
      });

      expect(status).toBe(403);
      expect(data.error).toBe('identity_required');
      expect(data.authorize_url).toContain('/oauth/authorize');
      expect(data.authorize_url).toContain('token=');
      expect(data.tenant_id).toBeTruthy();
    });

    test('jwt_exchange: user linked → returns access_token', async () => {
      // Pre-link the user
      const userKey = `${REGISTRY_ISSUER}:user_123`;
      linkedUsers.set(userKey, { atlasUserId: 'atlas_user_existing', tenantId: 'local_tenant_1' });
      tenantLinks.set(`${REGISTRY_ISSUER}:tenant_abc`, 'local_tenant_1');

      const jwt = await signRegistryJwt();
      const { status, data } = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: jwt,
      });

      expect(status).toBe(200);
      expect(data.access_token).toBeTruthy();
      expect(data.token_type).toBe('Bearer');
      expect(data.user_id).toBe('atlas_user_existing');
      expect(data.tenant_id).toBe('local_tenant_1');
    });

    test('jwt_exchange: missing assertion → 400', async () => {
      const { status, data } = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
      });

      expect(status).toBe(400);
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('assertion');
    });

    test('jwt_exchange: invalid JWT → 500', async () => {
      const { status, data } = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: 'not.a.valid.jwt',
      });

      // exchange_token will fail to parse the JWT
      expect(status).toBeGreaterThanOrEqual(400);
      expect(data.error).toBeTruthy();
    });

    test('jwt_exchange: tenant auto-created on first exchange', async () => {
      linkedUsers.clear();
      tenantLinks.clear();

      const jwt = await signRegistryJwt({ tenantId: 'new_tenant_xyz' });
      const { data } = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: jwt,
      });

      // Should return identity_required but tenant should be created
      expect(data.error).toBe('identity_required');
      expect(data.tenant_id).toBeTruthy();
      
      // Verify tenant was auto-linked
      expect(tenantLinks.has(`${REGISTRY_ISSUER}:new_tenant_xyz`)).toBe(true);
    });

    test('jwt_exchange: idempotent — second call same result', async () => {
      const userKey = `${REGISTRY_ISSUER}:user_idempotent`;
      linkedUsers.set(userKey, { atlasUserId: 'atlas_user_idem', tenantId: 'local_t' });
      tenantLinks.set(`${REGISTRY_ISSUER}:tenant_abc`, 'local_t');

      const jwt = await signRegistryJwt({ sub: 'user_idempotent' });
      
      const first = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: jwt,
      });
      const second = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: jwt,
      });

      expect(first.data.user_id).toBe(second.data.user_id);
      expect(first.data.tenant_id).toBe(second.data.tenant_id);
    });

    test('unsupported grant_type → 400', async () => {
      const { status, data } = await postOAuthToken(SERVER_PORT, {
        grant_type: 'authorization_code',
      });

      expect(status).toBe(400);
      expect(data.error).toBe('unsupported_grant_type');
    });

    test('client_credentials without creds → 400', async () => {
      const { status, data } = await postOAuthToken(SERVER_PORT, {
        grant_type: 'client_credentials',
      });

      expect(status).toBe(400);
      expect(data.error).toBe('invalid_request');
    });
  });

  // ─── /oauth/authorize tests ────────────────────────────────────

  describe('GET /oauth/authorize', () => {
    test('valid token, user not linked → redirects to IdP', async () => {
      linkedUsers.clear();
      tenantLinks.clear();

      const jwt = await signRegistryJwt();
      const res = await getOAuthAuthorize(SERVER_PORT, {
        token: jwt,
        redirect_uri: 'http://registry.example.com/callback',
      });

      expect(res.status).toBe(302);
      expect(res.location).toBeTruthy();
      // Mock provider redirects to /oauth/callback
      expect(res.location).toContain('/oauth/callback');
      expect(authorizeCallCount).toBe(1);
    });

    test('valid token, user already linked → redirects back immediately', async () => {
      const userKey = `${REGISTRY_ISSUER}:user_123`;
      linkedUsers.set(userKey, { atlasUserId: 'atlas_linked_user', tenantId: 't' });

      const jwt = await signRegistryJwt();
      const res = await getOAuthAuthorize(SERVER_PORT, {
        token: jwt,
        redirect_uri: 'http://registry.example.com/callback',
      });

      expect(res.status).toBe(302);
      expect(res.location).toContain('registry.example.com/callback');
      expect(res.location).toContain('success=true');
      expect(res.location).toContain('atlas_linked_user');
    });

    test('missing token → 400', async () => {
      const res = await getOAuthAuthorize(SERVER_PORT, {
        redirect_uri: 'http://registry.example.com/callback',
      });

      expect(res.status).toBe(400);
      expect(res.data?.error).toBe('invalid_request');
    });

    test('invalid JWT → 401', async () => {
      const res = await getOAuthAuthorize(SERVER_PORT, {
        token: 'garbage.invalid.jwt',
        redirect_uri: 'http://registry.example.com/callback',
      });

      expect(res.status).toBe(401);
      expect(res.data?.error).toBe('invalid_token');
    });

    test('JWT from untrusted issuer → 401', async () => {
      // Sign with the right key but wrong issuer
      const jwt = await new SignJWT({ sub: 'hacker', tenantId: 't' } as any)
        .setProtectedHeader({ alg: 'ES256', kid: KID })
        .setIssuer('http://evil.example.com')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(registryPrivateKey);

      const res = await getOAuthAuthorize(SERVER_PORT, {
        token: jwt,
        redirect_uri: 'http://registry.example.com/callback',
      });

      expect(res.status).toBe(401);
    });
  });

  // ─── /oauth/callback tests ─────────────────────────────────────

  describe('GET /oauth/callback', () => {
    test('valid callback → links identity and redirects', async () => {
      linkedUsers.clear();
      const callbackUrl = new URL(`http://localhost:${SERVER_PORT}/oauth/callback`);
      callbackUrl.searchParams.set('code', 'mock_code');
      callbackUrl.searchParams.set('state', JSON.stringify({
        iss: REGISTRY_ISSUER,
        sub: 'new_user_456',
        tenantId: 'tenant_abc',
        redirectUri: 'http://registry.example.com/done',
      }));

      const res = await fetch(callbackUrl.toString(), { redirect: 'manual' });
      
      expect(res.status).toBe(302);
      const location = res.headers.get('Location')!;
      expect(location).toContain('registry.example.com/done');
      expect(location).toContain('success=true');
      expect(location).toContain('atlas_user_id=');
      expect(callbackCallCount).toBe(1);
      
      // Verify user was linked
      const userKey = `${REGISTRY_ISSUER}:new_user_456`;
      expect(linkedUsers.has(userKey)).toBe(true);
    });
  });

  // ─── Full E2E flow ─────────────────────────────────────────────

  describe('Full connect flow (end-to-end)', () => {
    test('complete flow: token → identity_required → authorize → callback → token succeeds', async () => {
      linkedUsers.clear();
      tenantLinks.clear();

      const jwt = await signRegistryJwt({ sub: 'flow_user_1', tenantId: 'flow_tenant' });

      // Step 1: POST /oauth/token → identity_required
      const { status: tokenStatus, data: tokenData } = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: jwt,
        redirect_uri: 'http://registry.example.com/callback',
      });

      expect(tokenStatus).toBe(403);
      expect(tokenData.error).toBe('identity_required');
      expect(tokenData.authorize_url).toBeTruthy();

      // Step 2: GET /oauth/authorize → redirect to IdP (mock)
      const authorizeUrl = new URL(tokenData.authorize_url);
      const authorizeRes = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
      
      expect(authorizeRes.status).toBe(302);
      const idpRedirect = authorizeRes.headers.get('Location')!;
      expect(idpRedirect).toContain('/oauth/callback');

      // Step 3: GET /oauth/callback → link identity + redirect
      const callbackRes = await fetch(idpRedirect, { redirect: 'manual' });
      
      expect(callbackRes.status).toBe(302);
      const finalRedirect = callbackRes.headers.get('Location')!;
      expect(finalRedirect).toContain('success=true');

      // Verify user is now linked
      const userKey = `${REGISTRY_ISSUER}:flow_user_1`;
      expect(linkedUsers.has(userKey)).toBe(true);

      // Step 4: POST /oauth/token again → now succeeds with access_token
      const jwt2 = await signRegistryJwt({ sub: 'flow_user_1', tenantId: 'flow_tenant' });
      const { status: tokenStatus2, data: tokenData2 } = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: jwt2,
      });

      expect(tokenStatus2).toBe(200);
      expect(tokenData2.access_token).toBeTruthy();
      expect(tokenData2.token_type).toBe('Bearer');
      expect(tokenData2.user_id).toBeTruthy();
    });

    test('tenant is created once, reused across users', async () => {
      linkedUsers.clear();
      tenantLinks.clear();

      // Two different users, same tenant
      const jwt1 = await signRegistryJwt({ sub: 'user_a', tenantId: 'shared_tenant' });
      const jwt2 = await signRegistryJwt({ sub: 'user_b', tenantId: 'shared_tenant' });

      const res1 = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: jwt1,
      });
      const res2 = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: jwt2,
      });

      // Both should reference the same local tenant
      expect(res1.data.tenant_id).toBe(res2.data.tenant_id);
      // But tenant should only have been created once
      expect(tenantLinks.size).toBe(1);
    });

    test('different tenants get different local IDs', async () => {
      linkedUsers.clear();
      tenantLinks.clear();

      const jwt1 = await signRegistryJwt({ sub: 'user_x', tenantId: 'company_a' });
      const jwt2 = await signRegistryJwt({ sub: 'user_y', tenantId: 'company_b' });

      const res1 = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: jwt1,
      });
      const res2 = await postOAuthToken(SERVER_PORT, {
        grant_type: 'jwt_exchange',
        assertion: jwt2,
      });

      expect(res1.data.tenant_id).not.toBe(res2.data.tenant_id);
      expect(tenantLinks.size).toBe(2);
    });
  });

  // ─── .well-known/configuration ─────────────────────────────────

  describe('.well-known/configuration', () => {
    test('advertises jwt_exchange grant type', async () => {
      const res = await fetch(`http://localhost:${SERVER_PORT}/.well-known/configuration`);
      const config = await res.json() as any;

      expect(config.supported_grant_types).toContain('jwt_exchange');
      expect(config.supported_grant_types).toContain('client_credentials');
      expect(config.authorization_endpoint).toContain('/oauth/authorize');
      expect(config.token_endpoint).toContain('/oauth/token');
    });
  });

  // ─── No identity provider configured ───────────────────────────

  describe('No OAuthIdentityProvider configured', () => {
    let bareServer: AgentServer;
    const BARE_PORT = 19892;

    beforeAll(async () => {
      const registry = createAgentRegistry();
      bareServer = createAgentServer(registry, {
        port: BARE_PORT,
        trustedIssuers: [{ issuer: REGISTRY_ISSUER, scopes: ['agents:execute'] }],
        // NO oauthIdentityProvider
      });
      await bareServer.start();
    });

    afterAll(() => {
      bareServer?.stop?.();
    });

    test('/oauth/authorize → 404 when no provider', async () => {
      const jwt = await signRegistryJwt();
      const res = await getOAuthAuthorize(BARE_PORT, {
        token: jwt,
        redirect_uri: 'http://example.com/callback',
      });

      expect(res.status).toBe(404);
      expect(res.data?.error).toBe('not_configured');
    });

    test('/oauth/callback → 404 when no provider', async () => {
      const res = await fetch(`http://localhost:${BARE_PORT}/oauth/callback?code=test&state=test`);
      const data = await res.json() as any;

      expect(res.status).toBe(404);
      expect(data.error).toBe('not_configured');
    });
  });
});
