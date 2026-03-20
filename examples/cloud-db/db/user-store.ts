/**
 * Postgres-backed UserStore using @slashfi/query-builder.
 *
 * Uses UserEntity + UserIdentityEntity for all operations.
 * Tokens in identities are encrypted at rest.
 */

import type postgres from "postgres";
import type { UserStore, User, UserIdentity } from "@slashfi/agents-sdk";
import { encryptSecret, decryptSecret } from "@slashfi/agents-sdk";
import { db, UserEntity, UserIdentityEntity } from "./schema.js";

function generateId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = prefix;
  for (let i = 0; i < 20; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function createPostgresUserStore(
  client: postgres.Sql,
  encryptionKey: string,
): UserStore {
  return {
    // ---- Users ----

    async createUser(input) {
      const now = new Date();
      await db.insert(UserEntity).values({
        id: input.id,
        tenant_id: input.tenantId,
        email: input.email,
        name: input.name,
        avatar_url: input.avatarUrl,
        metadata_json: input.metadata ? JSON.stringify(input.metadata) : undefined,
        created_at: now,
        updated_at: now,
      }).query();

      return {
        ...input,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      };
    },

    async getUser(userId) {
      const result = await db.from(UserEntity)
        .where((_) => _.usr.id.equals(userId))
        .limit(1);
      if (!result[0]) return null;
      return rowToUser(result[0]);
    },

    async getUserByEmail(tenantId, email) {
      const result = await db.from(UserEntity)
        .where((_) => _.usr.tenant_id.equals(tenantId))
        .where((_) => _.usr.email.equals(email))
        .limit(1);
      if (!result[0]) return null;
      return rowToUser(result[0]);
    },

    async listUsers(tenantId) {
      const result = await db.from(UserEntity)
        .where((_) => _.usr.tenant_id.equals(tenantId))
        .query();
      return result.result.map((r) => rowToUser(r.usr));
    },

    async updateUser(userId, updates) {
      const existing = await this.getUser(userId);
      if (!existing) return null;

      const fields: string[] = [];
      const values: Record<string, any> = { updated_at: new Date() };

      if (updates.email !== undefined) { values.email = updates.email; fields.push("email"); }
      if (updates.name !== undefined) { values.name = updates.name; fields.push("name"); }
      if (updates.avatarUrl !== undefined) { values.avatar_url = updates.avatarUrl; fields.push("avatar_url"); }
      if (updates.metadata !== undefined) { values.metadata_json = JSON.stringify(updates.metadata); fields.push("metadata_json"); }
      fields.push("updated_at");

      // Use raw SQL for dynamic field updates
      const setClauses = Object.entries(values).map(([k], i) => `${k} = $${i + 2}`).join(", ");
      const params = [userId, ...Object.values(values)];
      await client.unsafe(`UPDATE users SET ${setClauses} WHERE id = $1`, params);

      return this.getUser(userId);
    },

    async deleteUser(userId) {
      // Delete identities first
      await client.unsafe(`DELETE FROM user_identities WHERE user_id = $1`, [userId]);
      const result = await client.unsafe(`DELETE FROM users WHERE id = $1`, [userId]);
      return (result as any).count > 0;
    },

    // ---- Identities ----

    async createIdentity(input) {
      const now = new Date();
      const accessEnc = input.accessToken
        ? await encryptSecret(input.accessToken, encryptionKey)
        : undefined;
      const refreshEnc = input.refreshToken
        ? await encryptSecret(input.refreshToken, encryptionKey)
        : undefined;

      await db.insert(UserIdentityEntity).values({
        id: input.id,
        user_id: input.userId,
        provider: input.provider,
        provider_user_id: input.providerUserId,
        email: input.email,
        name: input.name,
        avatar_url: input.avatarUrl,
        access_token_encrypted: accessEnc,
        refresh_token_encrypted: refreshEnc,
        expires_at: input.expiresAt ? new Date(input.expiresAt) : undefined,
        token_type: input.tokenType,
        scopes: input.scopes ? JSON.stringify(input.scopes) : undefined,
        metadata_json: input.metadata ? JSON.stringify(input.metadata) : undefined,
        connected_at: now,
        updated_at: now,
      }).query();

      return {
        ...input,
        connectedAt: now.getTime(),
        updatedAt: now.getTime(),
      };
    },

    async getIdentity(identityId) {
      const result = await db.from(UserIdentityEntity)
        .where((_) => _.user_ident.id.equals(identityId))
        .limit(1);
      if (!result[0]) return null;
      return rowToIdentity(result[0], encryptionKey);
    },

    async getIdentityByProvider(userId, provider) {
      const result = await db.from(UserIdentityEntity)
        .where((_) => _.user_ident.user_id.equals(userId))
        .where((_) => _.user_ident.provider.equals(provider))
        .limit(1);
      if (!result[0]) return null;
      return rowToIdentity(result[0], encryptionKey);
    },

    async findIdentityByProviderUserId(provider, providerUserId) {
      const result = await db.from(UserIdentityEntity)
        .where((_) => _.user_ident.provider.equals(provider))
        .where((_) => _.user_ident.provider_user_id.equals(providerUserId))
        .limit(1);
      if (!result[0]) return null;
      return rowToIdentity(result[0], encryptionKey);
    },

    async listIdentities(userId) {
      const result = await db.from(UserIdentityEntity)
        .where((_) => _.user_ident.user_id.equals(userId))
        .query();
      const identities: UserIdentity[] = [];
      for (const r of result.result) {
        identities.push(await rowToIdentity(r.user_ident, encryptionKey));
      }
      return identities;
    },

    async updateIdentity(identityId, updates) {
      const existing = await this.getIdentity(identityId);
      if (!existing) return null;

      const values: Record<string, any> = { updated_at: new Date() };
      if (updates.email !== undefined) values.email = updates.email;
      if (updates.name !== undefined) values.name = updates.name;
      if (updates.avatarUrl !== undefined) values.avatar_url = updates.avatarUrl;
      if (updates.metadata !== undefined) values.metadata_json = JSON.stringify(updates.metadata);
      if (updates.accessToken !== undefined) {
        values.access_token_encrypted = await encryptSecret(updates.accessToken, encryptionKey);
      }
      if (updates.refreshToken !== undefined) {
        values.refresh_token_encrypted = await encryptSecret(updates.refreshToken, encryptionKey);
      }
      if (updates.expiresAt !== undefined) values.expires_at = new Date(updates.expiresAt);

      const setClauses = Object.entries(values).map(([k], i) => `${k} = $${i + 2}`).join(", ");
      const params = [identityId, ...Object.values(values)];
      await client.unsafe(`UPDATE user_identities SET ${setClauses} WHERE id = $1`, params);

      return this.getIdentity(identityId);
    },

    async deleteIdentity(identityId) {
      const result = await client.unsafe(`DELETE FROM user_identities WHERE id = $1`, [identityId]);
      return (result as any).count > 0;
    },
  };
}

function rowToUser(row: Record<string, any>): User {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email ?? undefined,
    name: row.name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

async function rowToIdentity(
  row: Record<string, any>,
  encryptionKey: string,
): Promise<UserIdentity> {
  const accessToken = row.access_token_encrypted
    ? await decryptSecret(row.access_token_encrypted, encryptionKey)
    : undefined;
  const refreshToken = row.refresh_token_encrypted
    ? await decryptSecret(row.refresh_token_encrypted, encryptionKey)
    : undefined;

  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    email: row.email ?? undefined,
    name: row.name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    accessToken,
    refreshToken,
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : undefined,
    tokenType: row.token_type ?? undefined,
    scopes: row.scopes ? JSON.parse(row.scopes) : undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    connectedAt: new Date(row.connected_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  };
}
