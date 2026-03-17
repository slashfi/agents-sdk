/**
 * Postgres Auth Store
 *
 * Implements the AuthStore interface using @slashfi/query-builder
 * for all database operations.
 */
import type postgres from "postgres";
import type { AuthStore, AuthClient, AuthToken } from "@slashfi/agents-sdk";
import type { CloudDb } from "./schema.js";

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

function rowToAuthClient(row: Record<string, any>): AuthClient {
  return {
    clientId: row.auth_client_client_id ?? row.client_id,
    clientSecretHash: row.auth_client_client_secret_hash ?? row.client_secret_hash,
    name: row.auth_client_name ?? row.name,
    scopes: parseScopes(row.auth_client_scopes ?? row.scopes),
    createdAt: new Date(row.auth_client_created_at ?? row.created_at).getTime(),
    selfRegistered: row.auth_client_self_registered ?? row.self_registered ?? false,
  };
}

export function createPostgresAuthStore(
  client: postgres.Sql,
  { db, AuthClient: AuthClientEntity, AuthToken: AuthTokenEntity }: CloudDb
): AuthStore {
  return {
    async createClient(name, scopes, selfRegistered) {
      const clientId = generateId("ag_");
      const clientSecret = generateSecret();
      const secretHash = await hashSecret(clientSecret);

      await db.insert(AuthClientEntity).values({
        client_id: clientId,
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
      if (hash !== (row.auth_client.client_secret_hash)) return null;

      return rowToAuthClient(row.auth_client);
    },

    async getClient(clientId) {
      const result = await db
        .from(AuthClientEntity)
        .where((_) => _.auth_client.client_id.equals(clientId))
        .limit(1);

      const row = result[0];
      if (!row) return null;

      return rowToAuthClient(row.auth_client);
    },

    async listClients() {
      const result = await db.from(AuthClientEntity).query();
      return result.result.map((row) => rowToAuthClient(row.auth_client));
    },

    async revokeClient(clientId) {
      // Deletes not yet in QB, use raw SQL (cascade deletes tokens)
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

      const tok = row.auth_token;
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
