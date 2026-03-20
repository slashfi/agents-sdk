import type { Sql } from "postgres";

export default {
  name: "1774002900000-add-tenant-identities",
  async up(sql: Sql) {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS tenant_identities (
        id VARCHAR PRIMARY KEY,
        tenant_id VARCHAR NOT NULL REFERENCES tenants(id),
        provider VARCHAR NOT NULL,
        provider_org_id VARCHAR NOT NULL,
        name VARCHAR,
        metadata_json TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        UNIQUE (provider, provider_org_id)
      )
    `);
  },
};
