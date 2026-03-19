/**
 * Postgres Auth Store
 *
 * Implements the AuthStore interface using @slashfi/query-builder
 * for all database operations.
 */
import type postgres from "postgres";
import type { AuthStore, AuthClient as AuthClientType, AuthToken as AuthTokenType } from "@slashfi/agents-sdk";
import { db, Tenant as TenantEntity, AuthClient as AuthClientEntity, AuthToken as AuthTokenEntity } from "./schema.js";

function generateId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = prefix;
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateSecret(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let secret = "sk_";
  for (let i = 0; i < 40; i++) {
    secret += chars[Math.floor(Math.random() * chars.length)];
  }
  return secret;
}

function generateToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "at_";
  for (let i = 0; i < 48; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

async function hashSecret(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Parse scopes from postgres - handles both TEXT[] and JSON string formats */
function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

function rowToAuthClient(row: Record<string, any>): AuthClientType & { tenantId?: string } {
  return {
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    name: row.name,
    scopes: parseScopes(row.scopes),
    createdAt: new Date(row.created_at).getTime(),
    selfRegistered: row.self_registered ?? false,
    tenantId: row.tenant_id,
  };
}

export function createPostgresAuthStore(
  client: postgres.Sql,
): AuthStore {
  return {
    async createTenant(name) {
      const id = `tenant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      await db.insert(TenantEntity).values({
        id,
        name,
        created_at: new Date(),
      }).query();
      return { tenantId: id };
    },

    async getTenant(tenantId) {
      const result = await db.from(TenantEntity)
        .where((_) => _.tenant.id.equals(tenantId))
        .limit(1);
      if (!result[0]) return null;
      return { id: result[0].id, name: result[0].name, createdAt: new Date(result[0].created_at).getTime() };
    },

    async listTenants() {
      const result = await db.from(TenantEntity).query();
      return result.result.map((row) => ({
        id: row.tenant.id,
        name: row.tenant.name,
        createdAt: new Date(row.tenant.created_at).getTime(),
      }));
    },

    async createClient(name, scopes, selfRegistered, tenantId) {
      const clientId = generateId("ag_");
      const clientSecret = generateSecret();
      const secretHash = await hashSecret(clientSecret);

      await db.insert(AuthClientEntity).values({
        client_id: clientId,
        tenant_id: tenantId,
        client_secret_hash: secretHash,
        name,
        scopes: JSON.stringify(scopes),
        self_registered: selfRegistered ?? false,
        created_at: new Date(),
      }).query();

      return { clientId, clientSecret };
    },

    async validateClient(clientId, clientSecret) {
      const result = await db
        .from(AuthClientEntity)
        .where((_) => _.auth_client.client_id.equals(clientId))
        .limit(1);

      const row = result[0];
      if (!row) return null;

      const hash = await hashSecret(clientSecret);
      if (hash !== row.client_secret_hash) return null;

      return rowToAuthClient(row);
    },

    async getClient(clientId) {
      const result = await db
        .from(AuthClientEntity)
        .where((_) => _.auth_client.client_id.equals(clientId))
        .limit(1);

      const row = result[0];
      if (!row) return null;

      return rowToAuthClient(row);
    },

    async listClients() {
      const result = await db.from(AuthClientEntity).query();
      return result.result.map((row) => rowToAuthClient(row));
    },

    async revokeClient(clientId) {
      await client.unsafe(`DELETE FROM auth_clients WHERE client_id = $1`, [clientId]);
      return true;
    },

    async rotateSecret(clientId) {
      const existing = await this.getClient(clientId);
      if (!existing) return null;

      const clientSecret = generateSecret();
      const secretHash = await hashSecret(clientSecret);

      await db.update(AuthClientEntity)
        .setFields((_) => [_.auth_client.client_secret_hash])
        .values({ client_secret_hash: secretHash })
        .where((_) => _.auth_client.client_id.equals(clientId))
        .query();

      return { clientSecret };
    },

    async storeToken(token) {
      await db.insert(AuthTokenEntity).values({
        token: token.token,
        client_id: token.clientId,
        scopes: JSON.stringify(token.scopes),
        issued_at: new Date(token.issuedAt),
        expires_at: new Date(token.expiresAt),
      }).query();
    },

    async validateToken(tokenString) {
      const result = await db
        .from(AuthTokenEntity)
        .where((_) => _.auth_token.token.equals(tokenString))
        .limit(1);

      const row = result[0];
      if (!row) return null;

      const tok = row;
      if (new Date() > new Date(tok.expires_at)) {
        await client.unsafe(`DELETE FROM auth_tokens WHERE token = $1`, [tokenString]);
        return null;
      }

      return {
        token: tok.token,
        clientId: tok.client_id,
        scopes: parseScopes(tok.scopes),
        issuedAt: new Date(tok.issued_at).getTime(),
        expiresAt: new Date(tok.expires_at).getTime(),
      };
    },

    async revokeToken(tokenString) {
      await client.unsafe(`DELETE FROM auth_tokens WHERE token = $1`, [tokenString]);
      return true;
    },
  };
}
