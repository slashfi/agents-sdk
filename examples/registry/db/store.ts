/**
 * Postgres Auth Store
 *
 * Implements the AuthStore interface using raw postgres queries.
 * The auth tables (auth_clients, auth_tokens) are managed separately
 * from the registry schema.
 */
import type postgres from "postgres";
import type { AuthStore, AuthClient, AuthToken } from "@slashfi/agents-sdk";

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

export function createPostgresAuthStore(client: postgres.Sql): AuthStore {
  return {
    async createClient(name, scopes, selfRegistered) {
      const clientId = generateId("ag_");
      const clientSecret = generateSecret();
      const secretHash = await hashSecret(clientSecret);

      await client.unsafe(
        `INSERT INTO auth_clients (client_id, client_secret_hash, name, scopes, self_registered, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [clientId, secretHash, name, JSON.stringify(scopes), selfRegistered ?? false]
      );

      return { clientId, clientSecret };
    },

    async validateClient(clientId, clientSecret) {
      const rows = await client.unsafe(
        `SELECT client_id, client_secret_hash, name, scopes, self_registered, created_at
         FROM auth_clients WHERE client_id = $1 LIMIT 1`,
        [clientId]
      );

      if (rows.length === 0) return null;

      const row = rows[0];
      const hash = await hashSecret(clientSecret);
      if (hash !== row.client_secret_hash) return null;

      return {
        clientId: row.client_id,
        clientSecretHash: row.client_secret_hash,
        name: row.name,
        scopes: parseScopes(row.scopes),
        createdAt: new Date(row.created_at).getTime(),
        selfRegistered: row.self_registered ?? false,
      };
    },

    async getClient(clientId) {
      const rows = await client.unsafe(
        `SELECT client_id, client_secret_hash, name, scopes, self_registered, created_at
         FROM auth_clients WHERE client_id = $1 LIMIT 1`,
        [clientId]
      );

      if (rows.length === 0) return null;

      const row = rows[0];
      return {
        clientId: row.client_id,
        clientSecretHash: row.client_secret_hash,
        name: row.name,
        scopes: parseScopes(row.scopes),
        createdAt: new Date(row.created_at).getTime(),
        selfRegistered: row.self_registered ?? false,
      };
    },

    async listClients() {
      const rows = await client.unsafe(
        `SELECT client_id, client_secret_hash, name, scopes, self_registered, created_at
         FROM auth_clients ORDER BY created_at`
      );
      return rows.map((row) => ({
        clientId: row.client_id,
        clientSecretHash: row.client_secret_hash,
        name: row.name,
        scopes: parseScopes(row.scopes),
        createdAt: new Date(row.created_at).getTime(),
        selfRegistered: row.self_registered ?? false,
      }));
    },

    async revokeClient(clientId) {
      await client.unsafe(
        `DELETE FROM auth_clients WHERE client_id = $1`,
        [clientId]
      );
      return true;
    },

    async rotateSecret(clientId) {
      const existing = await this.getClient(clientId);
      if (!existing) return null;

      const clientSecret = generateSecret();
      const secretHash = await hashSecret(clientSecret);

      await client.unsafe(
        `UPDATE auth_clients SET client_secret_hash = $1 WHERE client_id = $2`,
        [secretHash, clientId]
      );

      return { clientSecret };
    },

    async storeToken(token) {
      await client.unsafe(
        `INSERT INTO auth_tokens (token, client_id, scopes, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          token.token,
          token.clientId,
          JSON.stringify(token.scopes),
          new Date(token.issuedAt).toISOString(),
          new Date(token.expiresAt).toISOString(),
        ]
      );
    },

    async validateToken(tokenString) {
      const rows = await client.unsafe(
        `SELECT token, client_id, scopes, issued_at, expires_at
         FROM auth_tokens WHERE token = $1 LIMIT 1`,
        [tokenString]
      );

      if (rows.length === 0) return null;

      const row = rows[0];
      if (new Date() > new Date(row.expires_at)) {
        await client.unsafe(
          `DELETE FROM auth_tokens WHERE token = $1`,
          [tokenString]
        );
        return null;
      }

      return {
        token: row.token,
        clientId: row.client_id,
        scopes: parseScopes(row.scopes),
        issuedAt: new Date(row.issued_at).getTime(),
        expiresAt: new Date(row.expires_at).getTime(),
      };
    },

    async revokeToken(tokenString) {
      await client.unsafe(
        `DELETE FROM auth_tokens WHERE token = $1`,
        [tokenString]
      );
      return true;
    },
  };
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
