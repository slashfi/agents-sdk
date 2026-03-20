/**
 * @databases Agent
 *
 * Manages database connections (Postgres, CockroachDB, Snowflake).
 * Connections are scoped to the authenticated client (owner_id = JWT sub).
 * Config is encrypted at rest with AES-256-GCM.
 */

import postgres from "postgres";
import { defineAgent, defineTool } from "@slashfi/agents-sdk";
import type { ToolContext } from "@slashfi/agents-sdk";
import { db, Connection } from "../db/schema.js";
import { encrypt, decrypt, getEncryptionKey } from "../db/crypto.js";

function randomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "conn_";
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function getOwnerId(ctx: ToolContext): string {
  if (!ctx.callerId || ctx.callerId === "anonymous") {
    throw new Error("Authentication required. Get a token first via @auth/token.");
  }
  return ctx.callerId;
}

// ============================================
// Tools
// ============================================

const addConnection = defineTool({
  name: "add_connection",
  description: "Register a new database connection",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Friendly name for this connection" },
      connection: {
        type: "object",
        description: "Connection config (discriminated by type)",
        properties: {
          type: { type: "string", enum: ["postgres", "cockroachdb", "snowflake"], description: "Database type" },
          host: { type: "string", description: "Host (postgres/cockroachdb)" },
          port: { type: "number", description: "Port (default: 5432 for pg, 26257 for crdb)" },
          user: { type: "string", description: "Username" },
          password: { type: "string", description: "Password", secret: true },
          database: { type: "string", description: "Database name" },
          ssl: { type: "boolean", description: "Use SSL (default: true)" },
          account: { type: "string", description: "Snowflake account (e.g. xy12345.us-east-1)" },
          warehouse: { type: "string", description: "Snowflake warehouse" },
          schema: { type: "string", description: "Snowflake schema (default: PUBLIC)" },
          role: { type: "string", description: "Snowflake role" },
        },
        required: ["type"],
      },
    },
    required: ["name", "connection"],
  },
  execute: async (input: { name: string; connection: Record<string, unknown> }, ctx: ToolContext) => {
    const ownerId = getOwnerId(ctx);
    const connType = input.connection.type as string;

    // Validate required fields per type
    if (connType === "postgres" || connType === "cockroachdb") {
      if (!input.connection.host || !input.connection.user || !input.connection.database) {
        throw new Error("host, user, and database are required for postgres/cockroachdb");
      }
    } else if (connType === "snowflake") {
      if (!input.connection.account || !input.connection.user || !input.connection.warehouse || !input.connection.database) {
        throw new Error("account, user, warehouse, and database are required for snowflake");
      }
    } else {
      throw new Error(`Unsupported type: ${connType}. Use postgres, cockroachdb, or snowflake.`);
    }

    const id = randomId();
    const now = new Date();
    const configJson = JSON.stringify(input.connection);
    const configEncrypted = await encrypt(configJson, getEncryptionKey());

    await db.insert(Connection).values({
      id,
      owner_id: ownerId,
      name: input.name,
      type: connType,
      config_encrypted: configEncrypted,
      status: "active",
      created_at: now,
      updated_at: now,
    }).query();

    return { id, name: input.name, type: connType, status: "active" };
  },
});

const listConnections = defineTool({
  name: "list_connections",
  description: "List your database connections",
  inputSchema: { type: "object", properties: {} },
  execute: async (_input: unknown, ctx: ToolContext) => {
    const ownerId = getOwnerId(ctx);
    const result = await db.from(Connection)
      .where((_) => _.connection.owner_id.equals(ownerId))
      .query();

    return {
      connections: result.result.map((row) => ({
        id: row.connection.id,
        name: row.connection.name,
        type: row.connection.type,
        status: row.connection.status,
        created_at: row.connection.created_at,
      })),
    };
  },
});

const testConnection = defineTool({
  name: "test_connection",
  description: "Test connectivity to a registered database",
  inputSchema: {
    type: "object",
    properties: {
      connection_id: { type: "string", description: "Connection ID to test" },
    },
    required: ["connection_id"],
  },
  execute: async (input: { connection_id: string }, ctx: ToolContext) => {
    const ownerId = getOwnerId(ctx);
    const conn = await getConnectionHelper(input.connection_id, ownerId);

    try {
      if (conn.type === "postgres" || conn.type === "cockroachdb") {
        const client = postgres(buildPgUrl(conn.config));
        const result = await client.unsafe("SELECT 1 as ok");
        await client.end();
        return { success: true, message: `Connected to ${conn.name}`, result: result[0] };
      } else if (conn.type === "snowflake") {
        return { success: false, message: "Snowflake test not yet implemented" };
      }
      return { success: false, message: `Unknown type: ${conn.type}` };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

const queryConnection = defineTool({
  name: "query",
  description: "Execute a SQL query against a registered database connection",
  inputSchema: {
    type: "object",
    properties: {
      connection_id: { type: "string", description: "Connection ID to query" },
      sql: { type: "string", description: "SQL query to execute" },
    },
    required: ["connection_id", "sql"],
  },
  execute: async (input: { connection_id: string; sql: string }, ctx: ToolContext) => {
    const ownerId = getOwnerId(ctx);
    const conn = await getConnectionHelper(input.connection_id, ownerId);

    if (conn.type === "postgres" || conn.type === "cockroachdb") {
      const client = postgres(buildPgUrl(conn.config));
      try {
        const result = await client.unsafe(input.sql);
        return { rows: result, rowCount: result.length };
      } finally {
        await client.end();
      }
    } else if (conn.type === "snowflake") {
      throw new Error("Snowflake query not yet implemented");
    }
    throw new Error(`Unknown type: ${conn.type}`);
  },
});


const getConnection = defineTool({
  name: "get_connection",
  description: "Get details of a specific database connection",
  inputSchema: {
    type: "object",
    properties: {
      connection_id: { type: "string", description: "Connection ID" },
    },
    required: ["connection_id"],
  },
  execute: async (input: { connection_id: string }, ctx: ToolContext) => {
    const ownerId = getOwnerId(ctx);
    const conn = await getConnectionHelper(input.connection_id, ownerId);
    return { id: input.connection_id, name: conn.name, type: conn.type, status: "active" };
  },
});

const updateConnection = defineTool({
  name: "update_connection",
  description: "Update an existing database connection's name or config",
  inputSchema: {
    type: "object",
    properties: {
      connection_id: { type: "string", description: "Connection ID to update" },
      name: { type: "string", description: "New friendly name (optional)" },
      connection: {
        type: "object",
        description: "Updated connection config fields (merged with existing)",
        properties: {
          host: { type: "string" },
          port: { type: "number" },
          user: { type: "string" },
          password: { type: "string", secret: true },
          database: { type: "string" },
          ssl: { type: "boolean" },
          account: { type: "string" },
          warehouse: { type: "string" },
          schema: { type: "string" },
          role: { type: "string" },
        },
      },
    },
    required: ["connection_id"],
  },
  execute: async (input: { connection_id: string; name?: string; connection?: Record<string, unknown> }, ctx: ToolContext) => {
    const ownerId = getOwnerId(ctx);
    const existing = await getConnectionHelper(input.connection_id, ownerId);
    const newName = input.name ?? existing.name;
    const newConfig = input.connection
      ? { ...existing.config, ...input.connection }
      : existing.config;

    // Re-encrypt and store
    const configEncrypted = await encrypt(JSON.stringify(newConfig), getEncryptionKey());
    const pgClient = (globalThis as any).__pgClient;
    await pgClient.unsafe(
      "UPDATE connections SET name = $1, config_encrypted = $2, updated_at = $3 WHERE id = $4 AND owner_id = $5",
      [newName, configEncrypted, new Date(), input.connection_id, ownerId],
    );

    return { id: input.connection_id, name: newName, type: existing.type, updated: true };
  },
});

const removeConnection = defineTool({
  name: "remove_connection",
  description: "Remove a registered database connection",
  inputSchema: {
    type: "object",
    properties: {
      connection_id: { type: "string", description: "Connection ID to remove" },
    },
    required: ["connection_id"],
  },
  execute: async (input: { connection_id: string }, ctx: ToolContext) => {
    const ownerId = getOwnerId(ctx);
    // Verify ownership
    await getConnectionHelper(input.connection_id, ownerId);
    // QB doesn't support DELETE, use raw SQL
    const pgClient = (globalThis as any).__pgClient;
    await pgClient.unsafe(
      "DELETE FROM connections WHERE id = $1 AND owner_id = $2",
      [input.connection_id, ownerId],
    );
    return { deleted: true, id: input.connection_id };
  },
});

// ============================================
// Helpers
// ============================================

interface DecodedConnection {
  name: string;
  type: string;
  config: Record<string, unknown>;
}

async function getConnectionHelper(id: string, ownerId: string): Promise<DecodedConnection> {
  const result = await db.from(Connection)
    .where((_) => _.connection.id.equals(id))
    .limit(1);

  const row = result[0];
  if (!row) throw new Error(`Connection not found: ${id}`);
  if (row.owner_id !== ownerId) throw new Error(`Connection not found: ${id}`);

  const configJson = await decrypt(row.config_encrypted, getEncryptionKey());
  return {
    name: row.name,
    type: row.type,
    config: JSON.parse(configJson),
  };
}

function buildPgUrl(config: Record<string, unknown>): string {
  const host = config.host as string;
  const port = config.port ?? (config.type === "cockroachdb" ? 26257 : 5432);
  const user = config.user as string;
  const password = config.password as string;
  const database = config.database as string;
  const ssl = config.ssl !== false;
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${ssl ? "require" : "disable"}`;
}

// ============================================
// Agent Definition
// ============================================

export const databasesAgent = defineAgent({
  path: "@databases",
  entrypoint: `Database connections agent. Manages connections to PostgreSQL, CockroachDB, and Snowflake databases.

To add a connection, collect from the user:
- A friendly name
- Database type (postgres, cockroachdb, or snowflake)
- For postgres/cockroachdb: host, port, user, password, database
- For snowflake: account, user, password, warehouse, database, schema, role

For passwords and sensitive credentials, prefer using a secure link rather than having the user paste them directly.`,
  config: {
    name: "databases",
    description: "Manage database connections - connect Postgres, CockroachDB, and Snowflake databases",
    integration: {
      provider: "databases",
      displayName: "Databases",
      icon: "database",
      category: "infrastructure",
      description: "Connect PostgreSQL, CockroachDB, or Snowflake databases to query and manage them through your agent.",
      methods: {
        setup: "add_connection",
        list: "list_connections",
        connect: "test_connection",
        get: "get_connection",
        update: "update_connection",
      },
    },
  },
  tools: [addConnection, listConnections, testConnection, queryConnection, getConnection, updateConnection, removeConnection],
  visibility: "public",
});
