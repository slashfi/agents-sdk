/**
 * Postgres-backed IntegrationStore using @slashfi/query-builder.
 *
 * Uses ProviderConfigEntity + UserConnectionEntity for all operations.
 * Access tokens are encrypted at rest via SDK's crypto module.
 */

import type postgres from "postgres";
import type { IntegrationStore, ProviderConfig, UserConnection } from "@slashfi/agents-sdk";
import { encryptSecret, decryptSecret } from "@slashfi/agents-sdk";
import {
  db,
  ProviderConfigEntity,
  UserConnectionEntity,
} from "./schema.js";

export function createPostgresIntegrationStore(
  client: postgres.Sql,
  encryptionKey: string,
): IntegrationStore {
  return {
    // ---- Provider configs ----

    async getProvider(providerId) {
      const result = await db.from(ProviderConfigEntity)
        .where((_) => _.provider_config.id.equals(providerId))
        .limit(1);
      if (!result[0]) return null;
      return rowToProvider(result[0]);
    },

    async listProviders() {
      const result = await db.from(ProviderConfigEntity).query();
      return result.result.map((r) => rowToProvider(r.provider_config));
    },

    async upsertProvider(config) {
      const now = new Date();
      const existing = await this.getProvider(config.id);

      if (existing) {
        await db.update(ProviderConfigEntity)
          .setFields((_) => [
            _.provider_config.name,
            _.provider_config.type,
            _.provider_config.scope,
            _.provider_config.config_json,
            _.provider_config.updated_at,
          ])
          .values({
            name: config.name,
            type: config.type,
            scope: config.scope ?? "user",
            config_json: JSON.stringify(config),
            updated_at: now,
          })
          .where((_) => _.provider_config.id.equals(config.id))
          .query();
      } else {
        await db.insert(ProviderConfigEntity).values({
          id: config.id,
          name: config.name,
          type: config.type,
          scope: config.scope ?? "user",
          config_json: JSON.stringify(config),
          created_at: now,
          updated_at: now,
        }).query();
      }
    },

    async deleteProvider(providerId) {
      const result = await client.unsafe(
        `DELETE FROM provider_configs WHERE id = $1`,
        [providerId],
      );
      return (result as any).count > 0;
    },

    // ---- User connections ----

    async getConnection(userId, providerId) {
      const result = await db.from(UserConnectionEntity)
        .where((_) => _.user_conn.user_id.equals(userId))
        .where((_) => _.user_conn.provider_id.equals(providerId))
        .limit(1);
      if (!result[0]) return null;
      return rowToConnection(result[0], encryptionKey);
    },

    async listConnections(userId) {
      const result = await db.from(UserConnectionEntity)
        .where((_) => _.user_conn.user_id.equals(userId))
        .query();
      const connections: UserConnection[] = [];
      for (const r of result.result) {
        connections.push(await rowToConnection(r.user_conn, encryptionKey));
      }
      return connections;
    },

    async upsertConnection(connection) {
      const now = new Date();
      const accessEnc = await encryptSecret(connection.accessToken, encryptionKey);
      const refreshEnc = connection.refreshToken
        ? await encryptSecret(connection.refreshToken, encryptionKey)
        : undefined;

      const existing = await this.getConnection(connection.userId, connection.providerId);

      if (existing) {
        await db.update(UserConnectionEntity)
          .setFields((_) => [
            _.user_conn.access_token_encrypted,
            _.user_conn.refresh_token_encrypted,
            _.user_conn.expires_at,
            _.user_conn.token_type,
            _.user_conn.scopes,
            _.user_conn.updated_at,
          ])
          .values({
            access_token_encrypted: accessEnc,
            refresh_token_encrypted: refreshEnc,
            expires_at: connection.expiresAt ? new Date(connection.expiresAt) : undefined,
            token_type: connection.tokenType,
            scopes: connection.scopes ? JSON.stringify(connection.scopes) : undefined,
            updated_at: now,
          })
          .where((_) => _.user_conn.user_id.equals(connection.userId))
          .where((_) => _.user_conn.provider_id.equals(connection.providerId))
          .query();
      } else {
        await db.insert(UserConnectionEntity).values({
          user_id: connection.userId,
          provider_id: connection.providerId,
          access_token_encrypted: accessEnc,
          refresh_token_encrypted: refreshEnc,
          expires_at: connection.expiresAt ? new Date(connection.expiresAt) : undefined,
          token_type: connection.tokenType,
          scopes: connection.scopes ? JSON.stringify(connection.scopes) : undefined,
          connected_at: new Date(connection.connectedAt),
          updated_at: now,
        }).query();
      }
    },

    async deleteConnection(userId, providerId) {
      const result = await client.unsafe(
        `DELETE FROM user_connections WHERE user_id = $1 AND provider_id = $2`,
        [userId, providerId],
      );
      return (result as any).count > 0;
    },
  };
}

function rowToProvider(row: Record<string, any>): ProviderConfig {
  // The full config is stored as JSON
  return JSON.parse(row.config_json) as ProviderConfig;
}

async function rowToConnection(
  row: Record<string, any>,
  encryptionKey: string,
): Promise<UserConnection> {
  const accessToken = await decryptSecret(row.access_token_encrypted, encryptionKey);
  const refreshToken = row.refresh_token_encrypted
    ? await decryptSecret(row.refresh_token_encrypted, encryptionKey)
    : undefined;

  return {
    userId: row.user_id,
    providerId: row.provider_id,
    accessToken,
    refreshToken,
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : undefined,
    tokenType: row.token_type ?? undefined,
    scopes: row.scopes ? JSON.parse(row.scopes) : undefined,
    connectedAt: new Date(row.connected_at).getTime(),
  };
}
