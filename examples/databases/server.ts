/**
 * Database Agent Server
 *
 * Production-ready agent server with:
 * - @auth agent (OAuth2 client_credentials, Postgres-backed)
 * - @databases agent (real Postgres queries via Drizzle)
 * - Auto-migration and seeding on startup
 *
 * Environment variables:
 *   DATABASE_URL - Postgres connection string (required)
 *   ROOT_KEY     - Root key for admin operations (required)
 *   PORT         - Server port (default: 3000)
 *
 * Run: DATABASE_URL=postgres://... ROOT_KEY=rk_xxx bun examples/databases/server.ts
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

import {
  defineAgent,
  defineTool,
  createAgentRegistry,
  createAgentServer,
  createAuthAgent,
} from "../../src/index.js";
import type { ToolContext } from "../../src/index.js";

import * as schema from "./db/schema.js";
import { createPostgresAuthStore } from "./db/store.js";
import { seed } from "./db/seed.js";

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
const db = drizzle(client);

// Run migrations (create tables if they don't exist)
console.log("[db] Running migrations...");
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS auth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    self_registered BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES auth_clients(client_id) ON DELETE CASCADE,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    issued_at TIMESTAMP DEFAULT NOW() NOT NULL,
    expires_at TIMESTAMP NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount NUMERIC(10, 2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    category VARCHAR(50) NOT NULL
  );
`);
console.log("[db] Migrations complete.");

// Seed demo data
await seed(db);

// ============================================
// @databases Agent
// ============================================

const queryTool = defineTool({
  name: "query",
  description: "Execute a read-only SQL query against the database",
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
      throw new Error("Only SELECT queries are allowed via the query tool. Use execute_mutation for writes.");
    }

    console.log(`[${ctx.callerId}] query: ${input.sql}`);
    const result = await client.unsafe(input.sql);
    return {
      rows: result,
      rowCount: result.length,
    };
  },
});

const listTablesTool = defineTool({
  name: "list_tables",
  description: "List all available tables in the database",
  inputSchema: { type: "object", properties: {} },
  execute: async (_input: unknown, ctx: ToolContext) => {
    console.log(`[${ctx.callerId}] list_tables`);
    const result = await client.unsafe(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    return {
      tables: result.map((r: { table_name: string }) => r.table_name),
    };
  },
});

const describeTableTool = defineTool({
  name: "describe_table",
  description: "Get column information for a table",
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
    },
    required: ["table"],
  },
  execute: async (input: { table: string }, ctx: ToolContext) => {
    console.log(`[${ctx.callerId}] describe_table: ${input.table}`);
    const columns = await client.unsafe(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
      [input.table]
    );

    if (columns.length === 0) {
      throw new Error(`Table not found: ${input.table}`);
    }

    const count = await client.unsafe(
      `SELECT COUNT(*) as count FROM "${input.table}"`
    );

    return {
      table: input.table,
      columns: columns.map((c: { column_name: string; data_type: string; is_nullable: string; column_default: string | null }) => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === "YES",
        default: c.column_default,
      })),
      rowCount: Number(count[0].count),
    };
  },
});

const executeMutationTool = defineTool({
  name: "execute_mutation",
  description: "Execute a write operation (INSERT, UPDATE, DELETE)",
  inputSchema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "SQL mutation to execute" },
    },
    required: ["sql"],
  },
  execute: async (input: { sql: string }, ctx: ToolContext) => {
    const scopes = (ctx as ToolContext & { metadata?: { scopes?: string[] } }).metadata?.scopes ?? [];
    if (!scopes.includes("databases:write") && !scopes.includes("*")) {
      throw new Error("Insufficient scope: requires databases:write");
    }

    const normalized = input.sql.trim().toUpperCase();
    if (normalized.startsWith("SELECT")) {
      throw new Error("Use the query tool for SELECT statements.");
    }

    // Block dangerous operations
    if (normalized.startsWith("DROP") || normalized.startsWith("TRUNCATE") || normalized.startsWith("ALTER")) {
      throw new Error("DDL operations (DROP, TRUNCATE, ALTER) are not allowed.");
    }

    console.log(`[${ctx.callerId}] mutation: ${input.sql}`);
    const result = await client.unsafe(input.sql);
    return {
      rowCount: result.count ?? 0,
      command: normalized.split(" ")[0],
    };
  },
});

const databasesAgent = defineAgent({
  path: "@databases",
  entrypoint: "Database query agent. Provides SQL access to a Postgres database.",
  config: {
    name: "Databases",
    description: "Query and manage a Postgres database",
    supportedActions: ["execute_tool", "describe_tools", "load"],
  },
  tools: [queryTool, listTablesTool, describeTableTool, executeMutationTool],
  visibility: "internal",
});

// ============================================
// Server Setup
// ============================================

const registry = createAgentRegistry();

// Register @auth with Postgres-backed store
const authStore = createPostgresAuthStore(db);
registry.register(
  createAuthAgent({
    rootKey: ROOT_KEY,
    allowRegistration: false,
    tokenTtl: 3600,
    store: authStore,
  }),
);

// Register @databases
registry.register(databasesAgent);

// Start server
const server = createAgentServer(registry, {
  port: PORT,
  hostname: "0.0.0.0",
});

await server.start();
console.log(`\nRoot key: ${ROOT_KEY.slice(0, 6)}...`);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await server.stop();
  await client.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nShutting down (SIGTERM)...");
  await server.stop();
  await client.end();
  process.exit(0);
});
