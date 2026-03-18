/**
 * Cloud DB Schema
 *
 * Defines all tables via @slashfi/query-builder:
 * - auth_clients / auth_tokens: OAuth2 client_credentials auth
 * - tenants: multi-tenant isolation
 * - agents: registered agents with metadata
 * - agent_tools: tools exposed by each agent
 */

import { createDb, createDbDiscriminator } from "@slashfi/query-builder";
import type { SqlString } from "@slashfi/query-builder/lib/sql-string/index.js";
import type postgres from "postgres";

const discriminator = createDbDiscriminator("cloud-db");

export function createCloudDb(client: postgres.Sql) {
  const db = createDb({
    discriminator,
    query: async (_queryName: string, sql: SqlString) => {
      const query = sql.getQuery();
      const params = sql.getParameters();
      const result = await client.unsafe(query, params as any[]);
      return result as Record<string, any>[];
    },
    getQueryBuilderIndexes: async () => ({
      queryBuilderIndexes: {} as any,
    }),
  });

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

  class AuthClient {
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

  class AuthToken {
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

  class Tenant {
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

  class Agent {
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

  class AgentTool {
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
      .defaultAlias("agent_tool")
      .build();
  }

  db.register(AuthClient);
  db.register(AuthToken);
  db.register(Tenant);
  db.register(Agent);
  db.register(AgentTool);

  return { db, AuthClient, AuthToken, Tenant, Agent, AgentTool };
}

export type CloudDb = ReturnType<typeof createCloudDb>;
