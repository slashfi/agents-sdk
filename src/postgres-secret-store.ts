/**
 * Postgres-backed SecretStore.
 *
 * Uses secret + secret_association tables (created via qb migrations).
 * AES-256-GCM encryption via SDK's crypto module.
 */

import type { SecretStore } from "./secrets.js";
import { encryptSecret, decryptSecret } from "./crypto.js";

function randomSecretId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 24; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export interface PostgresSecretStoreOptions {
  /** Postgres client (postgres.js Sql instance) */
  client: { unsafe: (query: string, params?: unknown[]) => Promise<any[]> };
  /** AES-256-GCM encryption key */
  encryptionKey: string;
}

/**
 * Create a Postgres-backed SecretStore.
 * Requires secret + secret_association tables to exist (use qb generate + migrate).
 */
export function createPostgresSecretStore(
  options: PostgresSecretStoreOptions,
): SecretStore {
  const { client, encryptionKey } = options;

  return {
    async store(value: string, ownerId: string): Promise<string> {
      const id = randomSecretId();
      const encrypted = await encryptSecret(value, encryptionKey);

      await client.unsafe(
        `INSERT INTO secret (id, value_encrypted) VALUES ($1, $2)`,
        [id, encrypted],
      );

      await client.unsafe(
        `INSERT INTO secret_association (secret_id, entity_type, entity_id) VALUES ($1, $2, $3)`,
        [id, "owner", ownerId],
      );

      return id;
    },

    async resolve(id: string, ownerId: string): Promise<string | null> {
      const assoc = await client.unsafe(
        `SELECT 1 FROM secret_association WHERE secret_id = $1 AND entity_id = $2 LIMIT 1`,
        [id, ownerId],
      );
      if (assoc.length === 0) return null;

      const rows = await client.unsafe(
        `SELECT value_encrypted FROM secret WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) return null;

      return decryptSecret(rows[0].value_encrypted, encryptionKey);
    },

    async delete(id: string, ownerId: string): Promise<boolean> {
      const result = await client.unsafe(
        `DELETE FROM secret_association WHERE secret_id = $1 AND entity_id = $2`,
        [id, ownerId],
      );

      const remaining = await client.unsafe(
        `SELECT 1 FROM secret_association WHERE secret_id = $1 LIMIT 1`,
        [id],
      );
      if (remaining.length === 0) {
        await client.unsafe(`DELETE FROM secret WHERE id = $1`, [id]);
      }

      return (result as any).count > 0;
    },
  };
}
