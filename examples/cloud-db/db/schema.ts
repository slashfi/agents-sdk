/**
 * Cloud DB Schema
 *
 * Entity classes are top-level exports so `qb generate` can discover them.
 *
 * Tables:
 * - auth_clients / auth_tokens: OAuth2 client_credentials auth
 * - connections: database connections (postgres, cockroachdb, snowflake)
 */

import { createDb, createDbDiscriminator } from "@slashfi/query-builder";
import type { SqlString } from "@slashfi/query-builder/lib/sql-string/index.js";
import type postgres from "postgres";

const discriminator = createDbDiscriminator("cloud-db");

let queryFn: (queryName: string, sql: SqlString) => Promise<Record<string, any>[]> =
  async () => { throw new Error("DB not connected. Call connectDb() first."); };

const db = createDb({
  discriminator,
  query: async (queryName: string, sql: SqlString) => queryFn(queryName, sql),
  getQueryBuilderIndexes: async () => ({
    queryBuilderIndexes: {} as any,
  }),
});

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
  tenant_id: string | undefined;
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
      tenant_id: (_) => _.varchar({ isNullable: true }),
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
// Tenants Table
// ============================================

interface TenantSchema {
  id: string;
  name: string;
  created_at: Date;
}

export class Tenant {
  static readonly Table = db
    .buildTableFromSchema<TenantSchema>()
    .columns({
      id: (_) => _.varchar(),
      name: (_) => _.varchar(),
      created_at: (_) => _.timestamp(),
    })
    .primaryKey("id")
    .tableName("tenants")
    .introspect({ columns: "enforce" })
    .defaultAlias("tenant")
    .build();
}

// ============================================
// Connections Table
// ============================================

interface ConnectionSchema {
  id: string;
  owner_id: string;
  name: string;
  type: string;
  config_encrypted: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export class Connection {
  static readonly Table = db
    .buildTableFromSchema<ConnectionSchema>()
    .columns({
      id: (_) => _.varchar(),
      owner_id: (_) => _.varchar(),
      name: (_) => _.varchar(),
      type: (_) => _.varchar(),
      config_encrypted: (_) => _.varchar(),
      status: (_) => _.varchar(),
      created_at: (_) => _.timestamp(),
      updated_at: (_) => _.timestamp(),
    })
    .primaryKey("id")
    .tableName("connections")
    .introspect({ columns: "enforce" })
    .defaultAlias("connection")
    .build();
}


// ============================================
// Secrets Table
// ============================================

interface SecretSchema {
  id: string;
  value_encrypted: string;
  created_at: Date;
}

export class Secret {
  static readonly Table = db
    .buildTableFromSchema<SecretSchema>()
    .columns({
      id: (_) => _.varchar(),
      value_encrypted: (_) => _.varchar(),
      created_at: (_) => _.timestamp(),
    })
    .primaryKey("id")
    .tableName("secret")
    .introspect({ columns: "enforce" })
    .defaultAlias("secret")
    .build();
}


// ============================================
// Secret Association Table
// ============================================

interface SecretAssociationSchema {
  secret_id: string;
  entity_type: string;
  entity_id: string;
  created_at: Date;
}

export class SecretAssociation {
  static readonly Table = db
    .buildTableFromSchema<SecretAssociationSchema>()
    .columns({
      secret_id: (_) => _.varchar(),
      entity_type: (_) => _.varchar(),
      entity_id: (_) => _.varchar(),
      created_at: (_) => _.timestamp(),
    })
    .primaryKey("secret_id", "entity_type", "entity_id")
    .tableName("secret_association")
    .introspect({ columns: "enforce" })
    .defaultAlias("secret_assoc")
    .build();
}

// ============================================
// Integration Providers Table
// ============================================

interface ProviderConfigSchema {
  id: string;
  name: string;
  type: string;
  scope: string;
  config_json: string;
  created_at: Date;
  updated_at: Date;
}

export class ProviderConfigEntity {
  static readonly Table = db
    .buildTableFromSchema<ProviderConfigSchema>()
    .columns({
      id: (_) => _.varchar(),
      name: (_) => _.varchar(),
      type: (_) => _.varchar(),
      scope: (_) => _.varchar(),
      config_json: (_) => _.varchar(),
      created_at: (_) => _.timestamp(),
      updated_at: (_) => _.timestamp(),
    })
    .primaryKey("id")
    .tableName("provider_configs")
    .introspect({ columns: "enforce" })
    .defaultAlias("provider_config")
    .build();
}

// ============================================
// User Connections Table (OAuth tokens)
// ============================================

interface UserConnectionSchema {
  user_id: string;
  provider_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | undefined;
  expires_at: Date | undefined;
  token_type: string | undefined;
  scopes: string | undefined;
  connected_at: Date;
  updated_at: Date;
}

export class UserConnectionEntity {
  static readonly Table = db
    .buildTableFromSchema<UserConnectionSchema>()
    .columns({
      user_id: (_) => _.varchar(),
      provider_id: (_) => _.varchar(),
      access_token_encrypted: (_) => _.varchar(),
      refresh_token_encrypted: (_) => _.varchar({ isNullable: true }),
      expires_at: (_) => _.timestamp({ isNullable: true }),
      token_type: (_) => _.varchar({ isNullable: true }),
      scopes: (_) => _.varchar({ isNullable: true }),
      connected_at: (_) => _.timestamp(),
      updated_at: (_) => _.timestamp(),
    })
    .primaryKey("user_id", "provider_id")
    .tableName("user_connections")
    .introspect({ columns: "enforce" })
    .defaultAlias("user_conn")
    .build();
}

// ============================================
// Users Table
// ============================================

interface UserSchema {
  id: string;
  tenant_id: string;
  email: string | undefined;
  name: string | undefined;
  avatar_url: string | undefined;
  metadata_json: string | undefined;
  created_at: Date;
  updated_at: Date;
}

export class UserEntity {
  static readonly Table = db
    .buildTableFromSchema<UserSchema>()
    .columns({
      id: (_) => _.varchar(),
      tenant_id: (_) => _.varchar(),
      email: (_) => _.varchar({ isNullable: true }),
      name: (_) => _.varchar({ isNullable: true }),
      avatar_url: (_) => _.varchar({ isNullable: true }),
      metadata_json: (_) => _.varchar({ isNullable: true }),
      created_at: (_) => _.timestamp(),
      updated_at: (_) => _.timestamp(),
    })
    .primaryKey("id")
    .tableName("users")
    .introspect({ columns: "enforce" })
    .defaultAlias("usr")
    .build();
}

// ============================================
// User Identities Table
// ============================================

interface UserIdentitySchema {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  email: string | undefined;
  name: string | undefined;
  avatar_url: string | undefined;
  access_token_encrypted: string | undefined;
  refresh_token_encrypted: string | undefined;
  expires_at: Date | undefined;
  token_type: string | undefined;
  scopes: string | undefined;
  metadata_json: string | undefined;
  connected_at: Date;
  updated_at: Date;
}

export class UserIdentityEntity {
  static readonly Table = db
    .buildTableFromSchema<UserIdentitySchema>()
    .columns({
      id: (_) => _.varchar(),
      user_id: (_) => _.varchar(),
      provider: (_) => _.varchar(),
      provider_user_id: (_) => _.varchar(),
      email: (_) => _.varchar({ isNullable: true }),
      name: (_) => _.varchar({ isNullable: true }),
      avatar_url: (_) => _.varchar({ isNullable: true }),
      access_token_encrypted: (_) => _.varchar({ isNullable: true }),
      refresh_token_encrypted: (_) => _.varchar({ isNullable: true }),
      expires_at: (_) => _.timestamp({ isNullable: true }),
      token_type: (_) => _.varchar({ isNullable: true }),
      scopes: (_) => _.varchar({ isNullable: true }),
      metadata_json: (_) => _.varchar({ isNullable: true }),
      connected_at: (_) => _.timestamp(),
      updated_at: (_) => _.timestamp(),
    })
    .primaryKey("id")
    .tableName("user_identities")
    .introspect({ columns: "enforce" })
    .defaultAlias("user_ident")
    .build();
}
// Register all entities
db.register(Tenant);
db.register(AuthClient);
db.register(AuthToken);
db.register(Connection);
db.register(Secret);
db.register(SecretAssociation);
db.register(ProviderConfigEntity);
db.register(UserConnectionEntity);
db.register(UserEntity);
db.register(UserIdentityEntity);
