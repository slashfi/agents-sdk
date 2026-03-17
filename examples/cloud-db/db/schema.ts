/**
 * Agent Registry Schema
 *
 * Defines the tables for a hosted agent registry with auth:
 * - tenants: multi-tenant isolation
 * - agents: registered agents with metadata
 * - agent_tools: tools exposed by each agent
 */

import { createDb, createDbDiscriminator } from "@slashfi/query-builder";
import type { SqlString } from "@slashfi/query-builder/lib/sql-string/index.js";
import type postgres from "postgres";

// ============================================
// Database Setup
// ============================================

const discriminator = createDbDiscriminator("registry");

export function createRegistryDb(client: postgres.Sql) {
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

  db.register(Tenant);
  db.register(Agent);
  db.register(AgentTool);

  return { db, Tenant, Agent, AgentTool };
}

export type RegistryDb = ReturnType<typeof createRegistryDb>;
