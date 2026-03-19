import type postgres from "postgres";

export async function up(client: postgres.Sql): Promise<void> {
  await client.unsafe(`
    -- Provider configs
    CREATE TABLE IF NOT EXISTS provider_configs (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      type VARCHAR NOT NULL,
      scope VARCHAR NOT NULL DEFAULT 'user',
      config_json TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- User connections (OAuth tokens per user per provider)
    CREATE TABLE IF NOT EXISTS user_connections (
      user_id VARCHAR NOT NULL,
      provider_id VARCHAR NOT NULL,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT,
      expires_at TIMESTAMPTZ,
      token_type VARCHAR,
      scopes TEXT,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, provider_id)
    );

    -- Users
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR PRIMARY KEY,
      tenant_id VARCHAR NOT NULL,
      email VARCHAR,
      name VARCHAR,
      avatar_url VARCHAR,
      metadata_json TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_users_tenant_email ON users(tenant_id, email);

    -- User identities (OAuth provider links)
    CREATE TABLE IF NOT EXISTS user_identities (
      id VARCHAR PRIMARY KEY,
      user_id VARCHAR NOT NULL REFERENCES users(id),
      provider VARCHAR NOT NULL,
      provider_user_id VARCHAR NOT NULL,
      email VARCHAR,
      name VARCHAR,
      avatar_url VARCHAR,
      access_token_encrypted TEXT,
      refresh_token_encrypted TEXT,
      expires_at TIMESTAMPTZ,
      token_type VARCHAR,
      scopes TEXT,
      metadata_json TEXT,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_user_identities_user_id ON user_identities(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_provider_lookup ON user_identities(provider, provider_user_id);
  `);
}

export async function down(client: postgres.Sql): Promise<void> {
  await client.unsafe(`
    DROP TABLE IF EXISTS user_identities;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS user_connections;
    DROP TABLE IF EXISTS provider_configs;
  `);
}
