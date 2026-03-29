/**
 * Mock OIDC Provider for testing.
 *
 * A minimal OpenID Connect provider that runs locally.
 * Supports the authorization code flow with no user interaction.
 *
 * Usage:
 *   const server = await startMockOIDC({ port: 0 });
 *   // server.url = 'http://localhost:XXXXX'
 *   // server.issuer = server.url
 *   // Configure your app to use server.url as the OIDC provider
 *   await server.stop();
 */

const TEST_USER = {
  sub: 'test-user-001',
  email: 'test@example.com',
  name: 'Test User',
  picture: 'https://example.com/avatar.png',
  'https://slack.com/team_id': 'T_TEST',
  'https://slack.com/team_name': 'Test Workspace',
};

const TEST_CLIENT_ID = 'test-client-id';
const TEST_CLIENT_SECRET = 'test-client-secret';
const VALID_CODE = 'test-auth-code-12345';
const ACCESS_TOKEN = 'test-access-token-' + Date.now();

export interface MockOIDCServer {
  url: string;
  port: number;
  issuer: string;
  clientId: string;
  clientSecret: string;
  testUser: typeof TEST_USER;
  accessToken: string;
  stop: () => Promise<void>;
}

export async function startMockOIDC(opts: { port?: number } = {}): Promise<MockOIDCServer> {
  const server = Bun.serve({
    port: opts.port ?? 0,
    fetch(req) {
      const url = new URL(req.url);

      // Discovery
      if (url.pathname === '/.well-known/openid-configuration') {
        const base = `http://localhost:${server.port}`;
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          userinfo_endpoint: `${base}/userinfo`,
          jwks_uri: `${base}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          scopes_supported: ['openid', 'email', 'profile'],
        });
      }

      // Authorize - immediately redirect back with code
      if (url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri')!;
        const state = url.searchParams.get('state') ?? '';
        const sep = redirectUri.includes('?') ? '&' : '?';
        return Response.redirect(`${redirectUri}${sep}code=${VALID_CODE}&state=${state}`, 302);
      }

      // Token exchange
      if (url.pathname === '/token' && req.method === 'POST') {
        return Response.json({
          access_token: ACCESS_TOKEN,
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'openid email profile',
          id_token: 'fake.id.token',
        });
      }

      // UserInfo
      if (url.pathname === '/userinfo') {
        const auth = req.headers.get('authorization');
        if (auth !== `Bearer ${ACCESS_TOKEN}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        return Response.json({ ok: true, ...TEST_USER });
      }

      // Also support Slack-style openid.connect.userInfo
      if (url.pathname === '/api/openid.connect.userInfo') {
        return Response.json({ ok: true, ...TEST_USER });
      }

      // JWKS (empty - we don't validate JWTs in tests)
      if (url.pathname === '/jwks') {
        return Response.json({ keys: [] });
      }

      return new Response('Not found', { status: 404 });
    },
  });

  const base = `http://localhost:${server.port}`;

  return {
    url: base,
    port: server.port,
    issuer: base,
    clientId: TEST_CLIENT_ID,
    clientSecret: TEST_CLIENT_SECRET,
    testUser: TEST_USER,
    accessToken: ACCESS_TOKEN,
    stop: async () => { server.stop(); },
  };
}
