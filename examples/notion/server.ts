/**
 * Notion Integration Agent Server
 *
 * Agent server with:
 * - @auth agent (OAuth2 client_credentials, Postgres-backed)
 * - @notion agent (connect via OAuth + generic Notion API wrapper)
 *
 * Auth model:
 * - Server auth: @auth agent handles client_credentials for callers (e.g. atlas-api)
 * - User auth: per-user Notion OAuth tokens stored in integration_tokens table
 * - Connect flow returns structured response for platform-specific rendering:
 *   - OAuth integrations: { type: 'oauth', authUrl: '...' }
 *   - API key integrations: { type: 'api_key', fields: [...] }
 *
 * OAuth callback should live on atlas-api (option B) so it can:
 * 1. Exchange code for token (by calling remote server)
 * 2. Update Slack message to show success
 * 3. Re-invoke the agent to continue the original task
 *
 * Environment variables:
 *   DATABASE_URL          - Postgres connection string (required)
 *   ROOT_KEY              - Root key for admin operations (required)
 *   NOTION_CLIENT_ID      - Notion OAuth app client ID (required)
 *   NOTION_CLIENT_SECRET  - Notion OAuth app client secret (required)
 *   NOTION_REDIRECT_URI   - OAuth callback URL on atlas-api (required)
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

/**
 * Connect tool — initiates or completes a Notion connection.
 *
 * Returns a structured response so the calling platform (Slack, web, etc.)
 * can render the appropriate UI:
 *
 * For OAuth integrations (like Notion):
 *   { type: 'oauth', authUrl: '...', message: '...' }
 *   → Platform shows a button/link to the OAuth URL
 *
 * For API key integrations (like Datadog):
 *   { type: 'api_key', fields: [{ name, label, required }], message: '...' }
 *   → Platform prompts user for the key(s) inline
 *
 * The OAuth callback URL should point to atlas-api, which:
 * 1. Exchanges the code for a token (calling back to this server)
 * 2. Updates the Slack message to show success
 * 3. Re-invokes the agent to continue the original task
 *
 * The OAuth state param encodes context needed for this:
 *   { userId, slackChannel, slackMessageTs, branchId, originalPrompt }
 */
const connectTool = defineTool({
  name: 'connect',
  description: 'Connect a Notion account. Returns auth requirements for the calling platform to render.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'Atlas user ID to connect for' },
      state: {
        type: 'object',
        description: 'Platform context to thread through OAuth (slackChannel, slackMessageTs, branchId, originalPrompt)',
        properties: {
          slackChannel: { type: 'string' },
          slackMessageTs: { type: 'string' },
          branchId: { type: 'string' },
          originalPrompt: { type: 'string' },
        },
      },
    },
    required: ['userId'],
  },
  execute: async (input: { userId: string; state?: Record<string, string> }, _ctx: ToolContext) => {
    const existing = await getUserToken(input.userId);
    if (existing) return { connected: true, message: 'Already connected to Notion.' };

    // Encode user ID + platform context into OAuth state
    const oauthState = encodeURIComponent(JSON.stringify({
      userId: input.userId,
      ...input.state,
    }));

    const params = new URLSearchParams({
      client_id: NOTION_CLIENT_ID,
      redirect_uri: NOTION_REDIRECT_URI,
      response_type: 'code',
      owner: 'user',
      state: oauthState,
    });

    return {
      type: 'oauth' as const,
      authUrl: `https://api.notion.com/v1/oauth/authorize?${params}`,
      message: 'Connect your Notion account',
    };
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

/**
 * Store token tool — called by atlas-api after OAuth callback.
 * atlas-api exchanges the code with Notion, then calls this to store the token.
 */
const storeTokenTool = defineTool({
  name: 'store_token',
  description: 'Store a Notion OAuth token for a user. Called by atlas-api after OAuth callback.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'Atlas user ID' },
      accessToken: { type: 'string', description: 'Notion access token' },
      workspaceId: { type: 'string', description: 'Notion workspace ID' },
      workspaceName: { type: 'string', description: 'Notion workspace name' },
    },
    required: ['userId', 'accessToken'],
  },
  execute: async (input: { userId: string; accessToken: string; workspaceId?: string; workspaceName?: string }, _ctx: ToolContext) => {
    await storeUserToken(input.userId, {
      accessToken: input.accessToken,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
    });
    return { stored: true };
  },
});

/**
 * Call tool — generic Notion API wrapper.
 * Supports any Notion REST API endpoint.
 */
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
  tools: [connectTool, statusTool, storeTokenTool, callTool],
});

// ============================================
// Server
// ============================================

const registry = createAgentRegistry();
registry.register(createAuthAgent({ rootKey: ROOT_KEY, store: createPostgresAuthStore(db) }));
registry.register(notionAgent);

const server = createAgentServer(registry, { port: PORT });

await server.start();
console.log(`[server] Notion agent server running on :${PORT}`);
