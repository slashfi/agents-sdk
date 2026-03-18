/**
 * Postgres-backed SecretStore
 *
 * Stores secrets encrypted with AES-256-GCM in a `secrets` table.
 * Scoped to owner_id (client_id from JWT).
 */

import type postgres from "postgres";
import type { SecretStore } from "@slashfi/agents-sdk";
import { db, Secret } from "./schema.js";
import { encrypt, decrypt, getEncryptionKey } from "./crypto.js";

function randomSecretId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 24; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export function createPostgresSecretStore(client: postgres.Sql): SecretStore {
  const encKey = getEncryptionKey();

  return {
    async store(value: string, ownerId: string): Promise<string> {
      const id = randomSecretId();
      const encrypted = await encrypt(value, encKey);

      await db.insert(Secret).values({
        id,
        owner_id: ownerId,
        value_encrypted: encrypted,
        created_at: new Date(),
        expires_at: undefined,
      }).query();

      return `secret:${id}`;
    },

    async resolve(ref: string, ownerId: string): Promise<string | null> {
      const id = ref.replace(/^secret:/, "");

      const result = await db.from(Secret)
        .where((_) => _.secret.id.equals(id))
        .limit(1);

      const row = result[0];
      if (!row) return null;
      if (row.owner_id !== ownerId) return null;

      // Check expiration
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        await client.unsafe("DELETE FROM secrets WHERE id = $1", [id]);
        return null;
      }

      return decrypt(row.value_encrypted, encKey);
    },

    async delete(ref: string, ownerId: string): Promise<boolean> {
      const id = ref.replace(/^secret:/, "");
      const result = await client.unsafe(
        "DELETE FROM secrets WHERE id = $1 AND owner_id = $2",
        [id, ownerId]
      );
      return result.count > 0;
    },
  };
}
