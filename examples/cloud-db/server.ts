/**
 * Cloud DB Server
 *
 * Production-ready agent server for a cloud database with:
 * - @auth agent (OAuth2 client_credentials, Postgres-backed)
 * - @registry agent (query and manage registered agents via @slashfi/query-builder)
 * - Auto-migration on startup
 *
 * Environment variables:
 *   DATABASE_URL - Postgres connection string (required)
 *   ROOT_KEY     - Root key for admin operations (required)
 *   PORT         - Server port (default: 3000)
 *
 * Run: DATABASE_URL=postgres://... ROOT_KEY=rk_xxx bun server.ts
 */

import postgres from "postgres";

import {
  defineAgent,
  defineTool,
  createAgentRegistry,
  createAgentServer,
  createAuthAgent,
} from "@slashfi/agents-sdk";
import type { ToolContext } from "@slashfi/agents-sdk";

import { createCloudDb } from "./db/schema.js";
import { createPostgresAuthStore } from "./db/store.js";

// ============================================
// Config
// ============================================

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required");
  process.exit(1);
}

const ROOT_KEY = process.env.ROOT_KEY;
if (!ROOT_KEY) {
  console.error("ERROR: ROOT_KEY is required");
  process.exit(1);
}

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);

// ============================================
// Database Setup
// ============================================

console.log("[db] Connecting to Postgres...");
const client = postgres(DATABASE_URL);

// Run migrations (create tables if they don't exist)
console.log("[db] Running migrations...");
await client.unsafe(`
  CREATE TABLE IF NOT EXISTS auth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    self_registered BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES auth_clients(client_id) ON DELETE CASCADE,
    scopes TEXT NOT NULL DEFAULT '[]',
    issued_at TIMESTAMP DEFAULT NOW() NOT NULL,
    expires_at TIMESTAMP NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '0.1.0',
    status TEXT NOT NULL DEFAULT 'active',
    endpoint_url TEXT,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_tools (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    input_schema TEXT NOT NULL DEFAULT '{}'
  );
`);
console.log("[db] Migrations complete.");

// Initialize query builder
const cloudDb = createCloudDb(client);
const { db, Tenant, Agent, AgentTool } = cloudDb;


// ============================================
// @registry Agent
// ============================================

const listAgentsTool = defineTool({
  name: "list_agents",
  description: "List all registered agents, optionally filtered by tenant or status",
  inputSchema: {
    type: "object",
    properties: {
      tenant_id: { type: "string", description: "Filter by tenant ID" },
      status: { type: "string", description: "Filter by status (active, inactive)" },
    },
  },
  execute: async (input: { tenant_id?: string; status?: string }, ctx: ToolContext) => {
    console.log(`[${ctx.callerId}] list_agents`);

    // Build query with optional filters
    const conditions: string[] = [];
    const params: string[] = [];
    if (input.tenant_id) {
      params.push(input.tenant_id);
      conditions.push(`tenant_id = $${params.length}`);
    }
    if (input.status) {
      params.push(input.status);
      conditions.push(`status = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const agents = await client.unsafe(
      `SELECT * FROM agents ${where} ORDER BY created_at`,
      params
    );

    return { agents, count: agents.length };
  },
});

const getAgentTool = defineTool({
  name: "get_agent",
  description: "Get details about a specific agent including its tools",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "Agent ID" },
    },
    required: ["agent_id"],
  },
  execute: async (input: { agent_id: string }, ctx: ToolContext) => {
    console.log(`[${ctx.callerId}] get_agent: ${input.agent_id}`);

    const agents = await db
      .from(Agent)
      .where((_) => _.agent.id.equals(input.agent_id))
      .limit(1);

    if (!agents[0]) {
      throw new Error(`Agent not found: ${input.agent_id}`);
    }

    const toolsResult = await db
      .from(AgentTool)
      .where((_) => _.agent_tool.agent_id.equals(input.agent_id))
      .query();

    return { agent: agents[0], tools: toolsResult.result };
  },
});

const registerAgentTool = defineTool({
  name: "register_agent",
  description: "Register a new agent in the registry",
  inputSchema: {
    type: "object",
    properties: {
      tenant_id: { type: "string", description: "Tenant this agent belongs to" },
      name: { type: "string", description: "Agent name (e.g. @my-agent)" },
      description: { type: "string", description: "What this agent does" },
      version: { type: "string", description: "Semver version" },
      endpoint_url: { type: "string", description: "Agent's RPC endpoint URL" },
    },
    required: ["tenant_id", "name"],
  },
  execute: async (
    input: { tenant_id: string; name: string; description?: string; version?: string; endpoint_url?: string },
    ctx: ToolContext
  ) => {
    console.log(`[${ctx.callerId}] register_agent: ${input.name}`);

    const id = `agt_${randomId()}`;
    const now = new Date();

    await db.insert(Agent).values({
      id,
      tenant_id: input.tenant_id,
      name: input.name,
      description: input.description ?? "",
      version: input.version ?? "0.1.0",
      status: "active",
      endpoint_url: input.endpoint_url ?? undefined,
      created_at: now,
      updated_at: now,
    }).query();

    return { id, name: input.name, status: "active" };
  },
});

const listTenantsTool = defineTool({
  name: "list_tenants",
  description: "List all tenants in the registry",
  inputSchema: {
    type: "object",
    properties: {},
  },
  execute: async (_input: unknown, ctx: ToolContext) => {
    console.log(`[${ctx.callerId}] list_tenants`);

    const result = await db.from(Tenant).query();
    return { tenants: result.result, count: result.result.length };
  },
});

const queryTool = defineTool({
  name: "query",
  description: "Execute a read-only SQL query against the registry database",
  inputSchema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "SQL SELECT query to execute" },
    },
    required: ["sql"],
  },
  execute: async (input: { sql: string }, ctx: ToolContext) => {
    const normalized = input.sql.trim().toUpperCase();
    if (!normalized.startsWith("SELECT")) {
      throw new Error("Only SELECT queries are allowed via the query tool.");
    }

    console.log(`[${ctx.callerId}] query: ${input.sql}`);
    const result = await client.unsafe(input.sql);
    return { rows: result, rowCount: result.length };
  },
});

const registryAgent = defineAgent({
  name: "registry",
  description: "Agent registry - discover, register, and manage agents across tenants",
  tools: [listAgentsTool, getAgentTool, registerAgentTool, listTenantsTool, queryTool],
});

// ============================================
// Server
// ============================================

const agentRegistry = createAgentRegistry();

// Register @auth with Postgres-backed store
agentRegistry.register(
  createAuthAgent({
    rootKey: ROOT_KEY,
    store: createPostgresAuthStore(client, cloudDb),
    allowRegistration: true,
  })
);

// Register @registry
agentRegistry.register(registryAgent);

console.log(`[server] Starting on port ${PORT}...`);
const server = createAgentServer(agentRegistry, { port: PORT, hostname: "0.0.0.0" });
await server.start();
console.log(`[server] Agent registry running at http://localhost:${PORT}`);
console.log(`[server] Agents: ${agentRegistry.list().map((a) => `@${a.path}`).join(", ")}`);
console.log(`[server] Root key: ${ROOT_KEY.substring(0, 6)}...`);

// ============================================
// Helpers
// ============================================

function randomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
