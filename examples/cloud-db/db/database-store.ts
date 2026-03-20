/**
 * Postgres-backed DatabaseStore implementation.
 *
 * Uses AES-256-GCM encryption for connection configs.
 * Reuses the same crypto utilities as other stores.
 */

import type postgres from "postgres";
import type {
  DatabaseStore,
  DatabaseType,
  ConnectionStatus,
} from "@slashfi/agents-sdk";
import { encrypt, decrypt } from "./crypto.js";

function randomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "conn_";
  for (let i = 0; i < 16; i++)
    id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export function createPostgresDatabaseStore(
  client: postgres.Sql,
  encryptionKey: string,
): DatabaseStore {
  return {
    async addConnection(ownerId, name, type, config) {
      const id = randomId();
      const now = new Date();
      const configEncrypted = await encrypt(
        JSON.stringify(config),
        encryptionKey,
      );

      await client`
        INSERT INTO connections (id, owner_id, name, type, config_encrypted, status, created_at, updated_at)
        VALUES (${id}, ${ownerId}, ${name}, ${type}, ${configEncrypted}, ${'active'}, ${now}, ${now})
      `;

      return id;
    },

    async listConnections(ownerId) {
      const rows = await client`
        SELECT id, name, type, status, created_at
        FROM connections
        WHERE owner_id = ${ownerId}
        ORDER BY created_at DESC
      `;

      return rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        type: r.type as DatabaseType,
        status: r.status as ConnectionStatus,
        createdAt: r.created_at as Date,
      }));
    },

    async getConnection(id, ownerId) {
      const rows = await client`
        SELECT id, owner_id, name, type, config_encrypted, status, created_at, updated_at
        FROM connections
        WHERE id = ${id}
        LIMIT 1
      `;

      const row = rows[0];
      if (!row) return null;
      if (row.owner_id !== ownerId) return null;

      const configJson = await decrypt(
        row.config_encrypted as string,
        encryptionKey,
      );

      return {
        id: row.id as string,
        ownerId: row.owner_id as string,
        name: row.name as string,
        type: row.type as DatabaseType,
        config: JSON.parse(configJson),
        status: row.status as ConnectionStatus,
        createdAt: row.created_at as Date,
        updatedAt: row.updated_at as Date,
      };
    },

    async removeConnection(id, ownerId) {
      const result = await client`
        DELETE FROM connections
        WHERE id = ${id} AND owner_id = ${ownerId}
      `;
      return result.count > 0;
    },

    async updateStatus(id, ownerId, status) {
      await client`
        UPDATE connections
        SET status = ${status}, updated_at = ${new Date()}
        WHERE id = ${id} AND owner_id = ${ownerId}
      `;
    },
  };
}
