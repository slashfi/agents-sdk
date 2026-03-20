/**
 * Databases Agent (@databases)
 *
 * Built-in agent for managing database connections and executing queries.
 * Supports PostgreSQL, CockroachDB, and Snowflake.
 *
 * This is the first example of the "integration as agent" pattern:
 * instead of generic `call_integration({ provider: "databases", ... })`,
 * each integration is its own agent with typed tools.
 *
 * Tools:
 * - add_connection: Register a new database connection (encrypted at rest)
 * - list_connections: List your registered connections
 * - test_connection: Test connectivity to a registered connection
 * - query: Execute SQL against a registered connection
 * - remove_connection: Delete a registered connection
 *
 * @example
 * ```typescript
 * import { createAgentRegistry, createDatabasesAgent } from '@slashfi/agents-sdk';
 *
 * const registry = createAgentRegistry();
 * registry.register(createDatabasesAgent({
 *   store: myDatabaseStore,
 * }));
 * ```
 */

import { defineAgent, defineTool } from "../define.js";
import type { AgentDefinition, ToolContext, ToolDefinition } from "../types.js";

// ============================================
// Types
// ============================================

/** Supported database types */
export type DatabaseType = "postgres" | "cockroachdb" | "snowflake";

/** Connection status */
export type ConnectionStatus = "active" | "inactive" | "error";

/** A stored database connection */
export interface DatabaseConnection {
  id: string;
  ownerId: string;
  name: string;
  type: DatabaseType;
  /** Connection config (decrypted). Includes host, port, user, password, database, etc. */
  config: Record<string, unknown>;
  status: ConnectionStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Connection config for add_connection (before storage) */
export interface DatabaseConnectionInput {
  type: DatabaseType;
  /** PostgreSQL / CockroachDB fields */
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  /** Snowflake fields */
  account?: string;
  warehouse?: string;
  schema?: string;
  role?: string;
}

// ============================================
// Store Interface
// ============================================

/**
 * Storage backend for database connections.
 * Implementations should handle encryption of connection configs.
 */
export interface DatabaseStore {
  /** Add a new connection. Returns the generated ID. */
  addConnection(
    ownerId: string,
    name: string,
    type: DatabaseType,
    config: Record<string, unknown>,
  ): Promise<string>;

  /** List all connections for an owner (configs should be omitted or redacted). */
  listConnections(
    ownerId: string,
  ): Promise<Array<{ id: string; name: string; type: DatabaseType; status: ConnectionStatus; createdAt: Date }>>;

  /** Get a single connection with decrypted config. Returns null if not found or not owned. */
  getConnection(
    id: string,
    ownerId: string,
  ): Promise<DatabaseConnection | null>;

  /** Remove a connection. Returns true if deleted. */
  removeConnection(
    id: string,
    ownerId: string,
  ): Promise<boolean>;

  /** Update connection status. */
  updateStatus(
    id: string,
    ownerId: string,
    status: ConnectionStatus,
  ): Promise<void>;
}

// ============================================
// In-Memory Store (for testing)
// ============================================

export function createInMemoryDatabaseStore(): DatabaseStore {
  const connections = new Map<string, DatabaseConnection>();
  let counter = 0;

  return {
    async addConnection(ownerId, name, type, config) {
      const id = `conn_${++counter}`;
      const now = new Date();
      connections.set(id, {
        id,
        ownerId,
        name,
        type,
        config,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return id;
    },

    async listConnections(ownerId) {
      return [...connections.values()]
        .filter((c) => c.ownerId === ownerId)
        .map(({ id, name, type, status, createdAt }) => ({
          id,
          name,
          type,
          status,
          createdAt,
        }));
    },

    async getConnection(id, ownerId) {
      const conn = connections.get(id);
      if (!conn || conn.ownerId !== ownerId) return null;
      return conn;
    },

    async removeConnection(id, ownerId) {
      const conn = connections.get(id);
      if (!conn || conn.ownerId !== ownerId) return false;
      connections.delete(id);
      return true;
    },

    async updateStatus(id, ownerId, status) {
      const conn = connections.get(id);
      if (conn && conn.ownerId === ownerId) {
        conn.status = status;
        conn.updatedAt = new Date();
      }
    },
  };
}

// ============================================
// Query Execution Helpers
// ============================================

export function buildPgUrl(config: Record<string, unknown>): string {
  const host = config.host as string;
  const port = config.port ?? (config.type === "cockroachdb" ? 26257 : 5432);
  const user = config.user as string;
  const password = config.password as string;
  const database = config.database as string;
  const ssl = config.ssl !== false;
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${ssl ? "require" : "disable"}`;
}

// ============================================
// Options
// ============================================

export interface DatabasesAgentOptions {
  /** Database store backend */
  store: DatabaseStore;

  /**
   * Optional query executor for running SQL.
   * If not provided, the agent creates ephemeral connections per query.
   * Accepts connection config + SQL, returns rows.
   */
  queryExecutor?: (
    type: DatabaseType,
    config: Record<string, unknown>,
    sql: string,
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;

  /**
   * Optional connection tester.
   * If not provided, the agent creates ephemeral connections to test.
   */
  connectionTester?: (
    type: DatabaseType,
    config: Record<string, unknown>,
  ) => Promise<{ success: boolean; message: string }>;
}

// ============================================
// Create Databases Agent
// ============================================

export function createDatabasesAgent(
  options: DatabasesAgentOptions,
): AgentDefinition {
  const { store } = options;

  function getOwnerId(ctx: ToolContext): string {
    if (!ctx.callerId || ctx.callerId === "anonymous") {
      throw new Error(
        "Authentication required. Get a token first via @auth/token.",
      );
    }
    return ctx.callerId;
  }

  const queryExecutor = options.queryExecutor ?? (async () => {
    throw new Error(
      "No queryExecutor provided. Pass a queryExecutor function to createDatabasesAgent options.",
    );
  });
  const connectionTester = options.connectionTester ?? (async () => {
    throw new Error(
      "No connectionTester provided. Pass a connectionTester function to createDatabasesAgent options.",
    );
  });

  // ---- add_connection ----
  const addConnectionTool = defineTool({
    name: "add_connection",
    description: "Register a new database connection. Config is encrypted at rest.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Friendly name for this connection" },
        connection: {
          type: "object",
          description: "Connection config (discriminated by type)",
          properties: {
            type: {
              type: "string",
              enum: ["postgres", "cockroachdb", "snowflake"],
              description: "Database type",
            },
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
    execute: async (
      input: { name: string; connection: DatabaseConnectionInput },
      ctx: ToolContext,
    ) => {
      const ownerId = getOwnerId(ctx);
      const connType = input.connection.type;

      // Validate required fields per type
      if (connType === "postgres" || connType === "cockroachdb") {
        if (!input.connection.host || !input.connection.user || !input.connection.database) {
          throw new Error("host, user, and database are required for postgres/cockroachdb");
        }
      } else if (connType === "snowflake") {
        if (
          !input.connection.account ||
          !input.connection.user ||
          !input.connection.warehouse ||
          !input.connection.database
        ) {
          throw new Error(
            "account, user, warehouse, and database are required for snowflake",
          );
        }
      } else {
        throw new Error(
          `Unsupported type: ${connType}. Use postgres, cockroachdb, or snowflake.`,
        );
      }

      const id = await store.addConnection(
        ownerId,
        input.name,
        connType,
        input.connection as unknown as Record<string, unknown>,
      );

      return { id, name: input.name, type: connType, status: "active" };
    },
  });

  // ---- list_connections ----
  const listConnectionsTool = defineTool({
    name: "list_connections",
    description: "List your registered database connections",
    visibility: "public" as const,
    inputSchema: { type: "object" as const, properties: {} },
    execute: async (_input: unknown, ctx: ToolContext) => {
      const ownerId = getOwnerId(ctx);
      const connections = await store.listConnections(ownerId);
      return { connections, count: connections.length };
    },
  });

  // ---- test_connection ----
  const testConnectionTool = defineTool({
    name: "test_connection",
    description: "Test connectivity to a registered database connection",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        connection_id: { type: "string", description: "Connection ID to test" },
      },
      required: ["connection_id"],
    },
    execute: async (input: { connection_id: string }, ctx: ToolContext) => {
      const ownerId = getOwnerId(ctx);
      const conn = await store.getConnection(input.connection_id, ownerId);
      if (!conn) throw new Error(`Connection not found: ${input.connection_id}`);

      const result = await connectionTester(conn.type, conn.config);

      // Update status based on test result
      await store.updateStatus(
        input.connection_id,
        ownerId,
        result.success ? "active" : "error",
      );

      return result;
    },
  });

  // ---- query ----
  const queryTool = defineTool({
    name: "query",
    description: "Execute a SQL query against a registered database connection",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        connection_id: { type: "string", description: "Connection ID to query" },
        sql: { type: "string", description: "SQL query to execute" },
      },
      required: ["connection_id", "sql"],
    },
    execute: async (
      input: { connection_id: string; sql: string },
      ctx: ToolContext,
    ) => {
      const ownerId = getOwnerId(ctx);
      const conn = await store.getConnection(input.connection_id, ownerId);
      if (!conn) throw new Error(`Connection not found: ${input.connection_id}`);

      return queryExecutor(conn.type, conn.config, input.sql);
    },
  });

  // ---- remove_connection ----
  const removeConnectionTool = defineTool({
    name: "remove_connection",
    description: "Remove a registered database connection",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        connection_id: { type: "string", description: "Connection ID to remove" },
      },
      required: ["connection_id"],
    },
    execute: async (input: { connection_id: string }, ctx: ToolContext) => {
      const ownerId = getOwnerId(ctx);
      const deleted = await store.removeConnection(
        input.connection_id,
        ownerId,
      );
      if (!deleted) throw new Error(`Connection not found: ${input.connection_id}`);
      return { deleted: true, id: input.connection_id };
    },
  });

  // ---- Agent Definition ----
  return defineAgent({
    path: "@databases",
    entrypoint:
      "Database connections agent. Manages connections to PostgreSQL, CockroachDB, and Snowflake databases.\n\n" +
      "Available tools:\n" +
      "- add_connection: Register a new database connection (encrypted at rest)\n" +
      "- list_connections: List your registered connections\n" +
      "- test_connection: Test connectivity\n" +
      "- query: Execute SQL queries\n" +
      "- remove_connection: Delete a connection\n\n" +
      "For passwords and sensitive credentials, prefer using collect_secrets for secure collection.",
    config: {
      name: "databases",
      description:
        "Database connection management — add, test, query, and remove database connections",
    },
    tools: [
      addConnectionTool,
      listConnectionsTool,
      testConnectionTool,
      queryTool,
      removeConnectionTool,
    ] as ToolDefinition<ToolContext>[],
    visibility: "public",
  });
}
