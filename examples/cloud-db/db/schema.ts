/**
 * Cloud DB Schema
 *
 * Defines all tables via @slashfi/query-builder.
 * Entity classes are top-level exports so `qb generate` can discover them.
 *
 * Tables:
 * - auth_clients / auth_tokens: OAuth2 client_credentials auth
 * - tenants: multi-tenant isolation
 * - agents: registered agents with metadata
 * - agent_tools: tools exposed by each agent
 */

import { createDb, createDbDiscriminator } from "@slashfi/query-builder";
import type { SqlString } from "@slashfi/query-builder/lib/sql-string/index.js";
import type postgres from "postgres";

const discriminator = createDbDiscriminator("cloud-db");

// Placeholder db instance for schema definition.
// The real query function is wired up at runtime via `connectDb()`.
let queryFn: (queryName: string, sql: SqlString) => Promise<Record<string, any>[]> =
  async () => { throw new Error("DB not connected. Call connectDb() first."); };

const db = createDb({
  discriminator,
  query: async (queryName: string, sql: SqlString) => queryFn(queryName, sql),
  getQueryBuilderIndexes: async () => ({
    queryBuilderIndexes: {} as any,
  }),
});

/**
 * Wire the query-builder to a live postgres connection.
 * Call this once at server startup before any queries.
 */
export function connectDb(client: postgres.Sql) {
  queryFn = async (_queryName: string, sql: SqlString) => {
    const query = sql.getQuery();
    const params = sql.getParameters();
    const result = await client.unsafe(query, params as any[]);
    return result as Record<string, any>[];
  };
}

export { db };

// ============================================
// Auth Tables
// ============================================

interface AuthClientSchema {
  client_id: string;
  client_secret_hash: string;
  name: string;
  scopes: string;
  self_registered: boolean;
  created_at: Date;
}

export class AuthClient {
  static readonly Table = db
    .buildTableFromSchema<AuthClientSchema>()
    .columns({
      client_id: (_) => _.varchar(),
      client_secret_hash: (_) => _.varchar(),
      name: (_) => _.varchar(),
      scopes: (_) => _.varchar(),
      self_registered: (_) => _.boolean(),
      created_at: (_) => _.timestamp(),
    })
    .primaryKey("client_id")
    .tableName("auth_clients")
    .introspect({ columns: "enforce" })
    .defaultAlias("auth_client")
    .build();
}

interface AuthTokenSchema {
  token: string;
  client_id: string;
  scopes: string;
  issued_at: Date;
  expires_at: Date;
}

export class AuthToken {
  static readonly Table = db
    .buildTableFromSchema<AuthTokenSchema>()
    .columns({
      token: (_) => _.varchar(),
      client_id: (_) => _.varchar(),
      scopes: (_) => _.varchar(),
      issued_at: (_) => _.timestamp(),
      expires_at: (_) => _.timestamp(),
    })
    .primaryKey("token")
    .tableName("auth_tokens")
    .introspect({ columns: "enforce" })
    .defaultAlias("auth_token")
    .build();
}

// ============================================
// Tenant Table
// ============================================

interface TenantSchema {
  id: string;
  name: string;
  plan: string;
  created_at: Date;
}

export class Tenant {
  static readonly Table = db
    .buildTableFromSchema<TenantSchema>()
    .columns({
      id: (_) => _.varchar(),
      name: (_) => _.varchar(),
      plan: (_) => _.varchar(),
      created_at: (_) => _.timestamp(),
    })
    .primaryKey("id")
    .tableName("tenants")
    .introspect({ columns: "enforce" })
    .defaultAlias("tenant")
    .build();
}

// ============================================
// Agent Table
// ============================================

interface AgentSchema {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  version: string;
  status: string;
  endpoint_url: string | undefined;
  created_at: Date;
  updated_at: Date;
}

export class Agent {
  static readonly Table = db
    .buildTableFromSchema<AgentSchema>()
    .columns({
      id: (_) => _.varchar(),
      tenant_id: (_) => _.varchar(),
      name: (_) => _.varchar(),
      description: (_) => _.varchar(),
      version: (_) => _.varchar(),
      status: (_) => _.varchar(),
      endpoint_url: (_) => _.varchar({ isNullable: true }),
      created_at: (_) => _.timestamp(),
      updated_at: (_) => _.timestamp(),
    })
    .primaryKey("id")
    .tableName("agents")
    .introspect({ columns: "enforce" })
    .defaultAlias("agent")
    .build();
}

// ============================================
// Agent Tool Table
// ============================================

interface AgentToolSchema {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  input_schema: string;
}

export class AgentTool {
  static readonly Table = db
    .buildTableFromSchema<AgentToolSchema>()
    .columns({
      id: (_) => _.varchar(),
      agent_id: (_) => _.varchar(),
      name: (_) => _.varchar(),
      description: (_) => _.varchar(),
      input_schema: (_) => _.varchar(),
    })
    .primaryKey("id")
    .tableName("agent_tools")
    .introspect({ columns: "enforce" })
    .defaultAlias("agent_tool")
    .build();
}

// Register all entities
db.register(AuthClient);
db.register(AuthToken);
db.register(Tenant);
db.register(Agent);
db.register(AgentTool);
