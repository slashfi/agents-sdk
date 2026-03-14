/**
 * Database Agent Server Example
 *
 * Full lifecycle example showing:
 * - @auth agent with OAuth2 client_credentials
 * - @databases agent with query tools
 * - Discovery → Registration → Auth → Usage flow
 *
 * Run with: ROOT_KEY=rk_my_secret_key bun examples/databases/server.ts
 *
 * Then try:
 *   # 1. Discover (unauthenticated)
 *   curl localhost:3000/list | jq
 *
 *   # 2. Create client (admin)
 *   curl -X POST localhost:3000/call \
 *     -H "Authorization: Bearer rk_my_secret_key" \
 *     -H "Content-Type: application/json" \
 *     -d '{"action":"execute_tool","path":"@auth","tool":"create_client","params":{"name":"my-agent","scopes":["databases:read","databases:write"]}}'
 *
 *   # 3. Get token
 *   curl -X POST localhost:3000/oauth/token \
 *     -d "grant_type=client_credentials&client_id=<ID>&client_secret=<SECRET>"
 *
 *   # 4. Discover (authenticated)
 *   curl -H "Authorization: Bearer <TOKEN>" localhost:3000/list | jq
 *
 *   # 5. Query
 *   curl -X POST localhost:3000/call \
 *     -H "Authorization: Bearer <TOKEN>" \
 *     -H "Content-Type: application/json" \
 *     -d '{"action":"execute_tool","path":"@databases","tool":"query","params":{"sql":"SELECT * FROM users"}}'
 */

import {
  defineAgent,
  defineTool,
  createAgentRegistry,
  createAgentServer,
  createAuthAgent,
} from "../../src/index.js";
import type { ToolContext } from "../../src/index.js";

// ============================================
// Mock Database
// ============================================

interface MockDB {
  tables: Map<string, { columns: string[]; rows: Record<string, unknown>[] }>;
  connected: boolean;
}

function createMockDB(): MockDB {
  const db: MockDB = {
    tables: new Map(),
    connected: false,
  };

  // Seed some data
  db.tables.set("users", {
    columns: ["id", "name", "email", "created_at"],
    rows: [
      { id: 1, name: "Alice", email: "alice@example.com", created_at: "2025-01-15" },
      { id: 2, name: "Bob", email: "bob@example.com", created_at: "2025-02-20" },
      { id: 3, name: "Charlie", email: "charlie@example.com", created_at: "2025-03-10" },
    ],
  });

  db.tables.set("orders", {
    columns: ["id", "user_id", "amount", "status"],
    rows: [
      { id: 101, user_id: 1, amount: 99.99, status: "completed" },
      { id: 102, user_id: 2, amount: 149.50, status: "pending" },
      { id: 103, user_id: 1, amount: 29.99, status: "completed" },
      { id: 104, user_id: 3, amount: 200.00, status: "cancelled" },
    ],
  });

  db.tables.set("products", {
    columns: ["id", "name", "price", "category"],
    rows: [
      { id: 1, name: "Widget", price: 29.99, category: "tools" },
      { id: 2, name: "Gadget", price: 99.99, category: "electronics" },
      { id: 3, name: "Thingamajig", price: 149.50, category: "electronics" },
    ],
  });

  return db;
}

// Simple SQL parser for the mock (handles basic SELECT/INSERT/UPDATE/DELETE)
function executeMockSQL(db: MockDB, sql: string): { rows: Record<string, unknown>[]; rowCount: number; command: string } {
  if (!db.connected) throw new Error("Database not connected");

  const normalized = sql.trim().toUpperCase();

  if (normalized.startsWith("SELECT")) {
    // Extract table name from "FROM <table>"
    const fromMatch = sql.match(/FROM\s+(\w+)/i);
    if (!fromMatch) throw new Error(`Cannot parse table from: ${sql}`);
    const tableName = fromMatch[1].toLowerCase();
    const table = db.tables.get(tableName);
    if (!table) throw new Error(`Table not found: ${tableName}`);

    // Simple WHERE support
    let rows = [...table.rows];
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:ORDER|LIMIT|$)/i);
    if (whereMatch) {
      const condition = whereMatch[1].trim();
      const eqMatch = condition.match(/(\w+)\s*=\s*['"]?([^'"\s]+)['"]?/i);
      if (eqMatch) {
        const [, col, val] = eqMatch;
        rows = rows.filter((r) => String(r[col]) === val);
      }
    }

    // Simple LIMIT
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      rows = rows.slice(0, Number.parseInt(limitMatch[1]));
    }

    return { rows, rowCount: rows.length, command: "SELECT" };
  }

  if (normalized.startsWith("INSERT")) {
    return { rows: [], rowCount: 1, command: "INSERT" };
  }

  if (normalized.startsWith("UPDATE")) {
    return { rows: [], rowCount: 1, command: "UPDATE" };
  }

  if (normalized.startsWith("DELETE")) {
    return { rows: [], rowCount: 1, command: "DELETE" };
  }

  throw new Error(`Unsupported SQL command: ${sql}`);
}

// ============================================
// @databases Agent Definition
// ============================================

const mockDB = createMockDB();

const queryTool = defineTool({
  name: "query",
  description: "Execute a SQL query against the database",
  inputSchema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "SQL query to execute" },
    },
    required: ["sql"],
  },
  execute: async (input: { sql: string }, ctx: ToolContext) => {
    console.log(`[${ctx.callerId}] query: ${input.sql}`);
    const result = executeMockSQL(mockDB, input.sql);
    return {
      rows: result.rows,
      rowCount: result.rowCount,
      command: result.command,
    };
  },
});

const listTablesTool = defineTool({
  name: "list_tables",
  description: "List all available tables",
  inputSchema: { type: "object", properties: {} },
  execute: async (_input: unknown, ctx: ToolContext) => {
    console.log(`[${ctx.callerId}] list_tables`);
    if (!mockDB.connected) throw new Error("Database not connected");
    return {
      tables: Array.from(mockDB.tables.keys()),
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
    if (!mockDB.connected) throw new Error("Database not connected");
    const table = mockDB.tables.get(input.table);
    if (!table) throw new Error(`Table not found: ${input.table}`);
    return {
      table: input.table,
      columns: table.columns,
      rowCount: table.rows.length,
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
    // Check scope
    const scopes = (ctx as ToolContext & { metadata?: { scopes?: string[] } }).metadata?.scopes ?? [];
    if (!scopes.includes("databases:write") && !scopes.includes("*")) {
      throw new Error("Insufficient scope: requires databases:write");
    }

    console.log(`[${ctx.callerId}] execute_mutation: ${input.sql}`);
    const result = executeMockSQL(mockDB, input.sql);
    return {
      rowCount: result.rowCount,
      command: result.command,
    };
  },
});

const databasesAgent = defineAgent({
  path: "@databases",
  entrypoint: "Database query agent. Provides SQL access to connected databases.",
  config: {
    name: "Databases",
    description: "Query and manage databases",
    supportedActions: ["execute_tool", "describe_tools", "load"],
  },
  tools: [queryTool, listTablesTool, describeTableTool, executeMutationTool],
  visibility: "internal",
  runtime: () => ({
    onStart: async () => {
      console.log("[@databases] Connecting to database...");
      mockDB.connected = true;
      console.log("[@databases] Connected. Tables:", Array.from(mockDB.tables.keys()).join(", "));
    },
    onStop: async () => {
      console.log("[@databases] Closing database connections...");
      mockDB.connected = false;
      console.log("[@databases] Disconnected.");
    },
    selectTools: async (ctx) => {
      // Dynamic tool filtering based on caller scopes
      const scopes = (ctx as unknown as { metadata?: { scopes?: string[] } }).metadata?.scopes ?? [];
      const hasWrite = scopes.includes("databases:write") || scopes.includes("*");

      const tools = ["query", "list_tables", "describe_table"];
      if (hasWrite) tools.push("execute_mutation");
      return tools;
    },
  }),
});

// ============================================
// Server Setup
// ============================================

const ROOT_KEY = process.env.ROOT_KEY ?? "rk_default_dev_key";

const registry = createAgentRegistry();

// Register @auth (built-in)
registry.register(
  createAuthAgent({
    rootKey: ROOT_KEY,
    allowRegistration: false, // closed system - admin creates clients
    tokenTtl: 3600,
  }),
);

// Register @databases
registry.register(databasesAgent);

// Start server
const server = createAgentServer(registry, {
  port: 3000,
  hostname: "0.0.0.0",
});

// Lifecycle: call onStart for agents with runtimes
const runtime = databasesAgent.runtime?.();
await runtime?.onStart?.();

await server.start();

console.log(`\nRoot key: ${ROOT_KEY}`);
console.log("\nTry the full flow:");
console.log('  1. curl localhost:3000/list | jq');
console.log(`  2. curl -X POST localhost:3000/call -H "Authorization: Bearer ${ROOT_KEY}" -H "Content-Type: application/json" -d '{"action":"execute_tool","path":"@auth","tool":"create_client","params":{"name":"my-agent","scopes":["databases:read","databases:write"]}}'`);
console.log('  3. Use the clientId/clientSecret from step 2 to get a token');
console.log('  4. Use the token to query @databases');

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await runtime?.onStop?.();
  await server.stop();
  process.exit(0);
});
