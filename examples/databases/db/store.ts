/**
 * Postgres Auth Store using Drizzle
 */
import { eq, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AuthStore, AuthClient, AuthToken } from "../../../src/auth.js";
import { authClients, authTokens } from "./schema.js";

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

export function createPostgresAuthStore(db: PostgresJsDatabase): AuthStore {
  return {
    async createClient(name, scopes, selfRegistered) {
      const clientId = generateId("ag_");
      const clientSecret = generateSecret();
      const secretHash = await hashSecret(clientSecret);

      await db.insert(authClients).values({
        clientId,
        clientSecretHash: secretHash,
        name,
        scopes,
        selfRegistered: selfRegistered ?? false,
      });

      return { clientId, clientSecret };
    },

    async validateClient(clientId, clientSecret) {
      const rows = await db
        .select()
        .from(authClients)
        .where(eq(authClients.clientId, clientId))
        .limit(1);

      if (rows.length === 0) return null;

      const client = rows[0];
      const hash = await hashSecret(clientSecret);
      if (hash !== client.clientSecretHash) return null;

      return {
        clientId: client.clientId,
        clientSecretHash: client.clientSecretHash,
        name: client.name,
        scopes: client.scopes,
        createdAt: client.createdAt.getTime(),
        selfRegistered: client.selfRegistered ?? false,
      };
    },

    async getClient(clientId) {
      const rows = await db
        .select()
        .from(authClients)
        .where(eq(authClients.clientId, clientId))
        .limit(1);

      if (rows.length === 0) return null;

      const client = rows[0];
      return {
        clientId: client.clientId,
        clientSecretHash: client.clientSecretHash,
        name: client.name,
        scopes: client.scopes,
        createdAt: client.createdAt.getTime(),
        selfRegistered: client.selfRegistered ?? false,
      };
    },

    async listClients() {
      const rows = await db.select().from(authClients);
      return rows.map((c) => ({
        clientId: c.clientId,
        clientSecretHash: c.clientSecretHash,
        name: c.name,
        scopes: c.scopes,
        createdAt: c.createdAt.getTime(),
        selfRegistered: c.selfRegistered ?? false,
      }));
    },

    async revokeClient(clientId) {
      const result = await db
        .delete(authClients)
        .where(eq(authClients.clientId, clientId));
      return true; // cascade deletes tokens
    },

    async rotateSecret(clientId) {
      const client = await this.getClient(clientId);
      if (!client) return null;

      const clientSecret = generateSecret();
      const secretHash = await hashSecret(clientSecret);

      await db
        .update(authClients)
        .set({ clientSecretHash: secretHash })
        .where(eq(authClients.clientId, clientId));

      return { clientSecret };
    },

    async storeToken(token) {
      await db.insert(authTokens).values({
        token: token.token,
        clientId: token.clientId,
        scopes: token.scopes,
        issuedAt: new Date(token.issuedAt),
        expiresAt: new Date(token.expiresAt),
      });
    },

    async validateToken(tokenString) {
      const rows = await db
        .select()
        .from(authTokens)
        .where(eq(authTokens.token, tokenString))
        .limit(1);

      if (rows.length === 0) return null;

      const token = rows[0];
      if (new Date() > token.expiresAt) {
        // Clean up expired token
        await db.delete(authTokens).where(eq(authTokens.token, tokenString));
        return null;
      }

      return {
        token: token.token,
        clientId: token.clientId,
        scopes: token.scopes,
        issuedAt: token.issuedAt.getTime(),
        expiresAt: token.expiresAt.getTime(),
      };
    },

    async revokeToken(tokenString) {
      await db.delete(authTokens).where(eq(authTokens.token, tokenString));
      return true;
    },
  };
}
