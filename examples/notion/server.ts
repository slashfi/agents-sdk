/**
 * Notion Integration Agent Server
 *
 * Agent server with:
 * - @auth agent (OAuth2 client_credentials, Postgres-backed)
 * - @notion agent (connect via OAuth + generic Notion API wrapper)
 *
 * Environment variables:
 *   DATABASE_URL          - Postgres connection string (required)
 *   ROOT_KEY              - Root key for admin operations (required)
 *   NOTION_CLIENT_ID      - Notion OAuth app client ID (required)
 *   NOTION_CLIENT_SECRET  - Notion OAuth app client secret (required)
 *   NOTION_REDIRECT_URI   - OAuth callback URL (required)
 *   PORT                  - Server port (default: 3000)
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import {
  defineAgent,
  defineTool,
  createAgentRegistry,
  createAgentServer,
  createAuthAgent,
} from '../../src/index.js';
import type { ToolContext } from '../../src/index.js';
import { createPostgresAuthStore } from '../databases/db/store.js';

// ============================================
// Config
// ============================================

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL required'); process.exit(1); }
const ROOT_KEY = process.env.ROOT_KEY;
if (!ROOT_KEY) { console.error('ERROR: ROOT_KEY required'); process.exit(1); }
const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;
if (!NOTION_CLIENT_ID) { console.error('ERROR: NOTION_CLIENT_ID required'); process.exit(1); }
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;
if (!NOTION_CLIENT_SECRET) { console.error('ERROR: NOTION_CLIENT_SECRET required'); process.exit(1); }
const NOTION_REDIRECT_URI = process.env.NOTION_REDIRECT_URI;
if (!NOTION_REDIRECT_URI) { console.error('ERROR: NOTION_REDIRECT_URI required'); process.exit(1); }
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

// ============================================
// Database
// ============================================

console.log('[db] Connecting...');
const client = postgres(DATABASE_URL);
const db = drizzle(client);

console.log('[db] Running migrations...');
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS integration_tokens (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    workspace_id TEXT,
    workspace_name TEXT,
    connected_at TIMESTAMP DEFAULT NOW() NOT NULL,
    UNIQUE(user_id, provider)
  );
`);
console.log('[db] Migrations complete.');

// ============================================
// Token helpers
// ============================================

async function getUserToken(userId: string): Promise<string | null> {
  const rows = await client`
    SELECT access_token FROM integration_tokens
    WHERE user_id = ${userId} AND provider = 'notion' LIMIT 1
  `;
  return rows[0]?.access_token ?? null;
}

async function storeUserToken(userId: string, data: {
  accessToken: string;
  workspaceId?: string;
  workspaceName?: string;
}) {
  await client`
    INSERT INTO integration_tokens (user_id, provider, access_token, workspace_id, workspace_name)
    VALUES (${userId}, 'notion', ${data.accessToken}, ${data.workspaceId ?? null}, ${data.workspaceName ?? null})
    ON CONFLICT (user_id, provider)
    DO UPDATE SET
      access_token = ${data.accessToken},
      workspace_id = ${data.workspaceId ?? null},
      workspace_name = ${data.workspaceName ?? null},
      connected_at = NOW()
  `;
}

// ============================================
// @notion tools
// ============================================

const connectTool = defineTool({
  name: 'connect',
  description: 'Connect a Notion account. Returns an OAuth URL to authorize access.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'Atlas user ID to connect for' },
    },
    required: ['userId'],
  },
  execute: async (input: { userId: string }, _ctx: ToolContext) => {
    const existing = await getUserToken(input.userId);
    if (existing) return { connected: true, message: 'Already connected to Notion.' };

    const params = new URLSearchParams({
      client_id: NOTION_CLIENT_ID,
      redirect_uri: NOTION_REDIRECT_URI,
      response_type: 'code',
      owner: 'user',
      state: input.userId,
    });
    const authUrl = `https://api.notion.com/v1/oauth/authorize?${params}`;
    return { authUrl, message: 'Open this URL to connect your Notion account.' };
  },
});

const statusTool = defineTool({
  name: 'status',
  description: 'Check if a user has connected their Notion account.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'Atlas user ID to check' },
    },
    required: ['userId'],
  },
  execute: async (input: { userId: string }, _ctx: ToolContext) => {
    const token = await getUserToken(input.userId);
    return { connected: !!token };
  },
});

const callTool = defineTool({
  name: 'call',
  description: 'Make a Notion API call. Supports any Notion REST API endpoint.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'Atlas user ID (uses their Notion token)' },
      method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'], description: 'HTTP method' },
      path: { type: 'string', description: 'Notion API path, e.g. /v1/search, /v1/pages/{id}, /v1/databases/{id}/query' },
      body: { type: 'object', description: 'Request body for POST/PATCH requests' },
    },
    required: ['userId', 'method', 'path'],
  },
  execute: async (input: { userId: string; method: string; path: string; body?: object }, _ctx: ToolContext) => {
    const token = await getUserToken(input.userId);
    if (!token) {
      return { error: 'NOT_CONNECTED', message: 'User has not connected Notion. Call the connect tool first.' };
    }

    const url = input.path.startsWith('http')
      ? input.path
      : `https://api.notion.com${input.path}`;

    const res = await fetch(url, {
      method: input.method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      ...(input.body && { body: JSON.stringify(input.body) }),
    });

    const data = await res.json();
    if (!res.ok) {
      return { error: 'NOTION_API_ERROR', status: res.status, details: data };
    }
    return data;
  },
});

// ============================================
// @notion agent
// ============================================

const notionAgent = defineAgent({
  path: '@notion',
  description: 'Connect and interact with Notion. Supports OAuth connection and any Notion API call.',
  tools: [connectTool, statusTool, callTool],
});

// ============================================
// Server
// ============================================

const registry = createAgentRegistry();
registry.register(createAuthAgent({ rootKey: ROOT_KEY, store: createPostgresAuthStore(db) }));
registry.register(notionAgent);

const server = createAgentServer(registry, {
  port: PORT,
  // Handle OAuth callback via onNotFound
  onNotFound: async (req) => {
    const url = new URL(req.url);

    // Notion OAuth callback
    if (url.pathname === '/agents/@notion/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const userId = url.searchParams.get('state');

      if (!code || !userId) {
        return new Response('Missing code or state parameter', { status: 400 });
      }

      try {
        const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${btoa(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: NOTION_REDIRECT_URI,
          }),
        });

        const tokenData = await tokenRes.json() as {
          access_token?: string;
          workspace_id?: string;
          workspace_name?: string;
        };

        if (!tokenData.access_token) {
          console.error('[notion] Token exchange failed:', tokenData);
          return new Response('Failed to exchange code for token', { status: 500 });
        }

        await storeUserToken(userId, {
          accessToken: tokenData.access_token,
          workspaceId: tokenData.workspace_id,
          workspaceName: tokenData.workspace_name,
        });

        console.log(`[notion] Connected user ${userId} to workspace ${tokenData.workspace_name}`);
        return new Response(
          '<html><body><h2>Connected to Notion!</h2><p>You can close this tab and return to Slack.</p></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      } catch (err) {
        console.error('[notion] OAuth callback error:', err);
        return new Response('Internal error during OAuth', { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
});

await server.start();
console.log(`[server] Notion agent server running on :${PORT}`);
