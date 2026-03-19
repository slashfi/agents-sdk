/**
 * Postgres-backed SecretStore using @slashfi/query-builder.
 *
 * Uses Secret + SecretAssociation QB entities for all operations.
 * AES-256-GCM encryption via SDK's crypto module.
 */

import type postgres from "postgres";
import type { SecretStore } from "@slashfi/agents-sdk";
import { encryptSecret, decryptSecret } from "@slashfi/agents-sdk";
import { db, Secret, SecretAssociation } from "./schema.js";

function randomSecretId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 24; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export function createPostgresSecretStore(
  client: postgres.Sql,
  encryptionKey: string,
): SecretStore {
  return {
    async store(value: string, ownerId: string): Promise<string> {
      const id = randomSecretId();
      const encrypted = await encryptSecret(value, encryptionKey);

      await db.insert(Secret).values({
        id,
        value_encrypted: encrypted,
        created_at: new Date(),
      }).query();

      await db.insert(SecretAssociation).values({
        secret_id: id,
        entity_type: "owner",
        entity_id: ownerId,
        created_at: new Date(),
      }).query();

      return id;
    },

    async resolve(id: string, ownerId: string): Promise<string | null> {
      // Check association via QB
      const assocResult = await db.from(SecretAssociation)
        .where((_) => _.secret_assoc.secret_id.equals(id))
        .where((_) => _.secret_assoc.entity_id.equals(ownerId))
        .limit(1);

      if (!assocResult[0]) return null;

      // Get encrypted value
      const secretResult = await db.from(Secret)
        .where((_) => _.secret.id.equals(id))
        .limit(1);

      if (!secretResult[0]) return null;

      return decryptSecret(secretResult[0].value_encrypted, encryptionKey);
    },

    async delete(id: string, ownerId: string): Promise<boolean> {
      // QB doesn't support DELETE, use raw SQL
      const result = await client.unsafe(
        `DELETE FROM secret_association WHERE secret_id = $1 AND entity_id = $2`,
        [id, ownerId],
      );

      // If no more associations, delete the secret itself
      const remaining = await db.from(SecretAssociation)
        .where((_) => _.secret_assoc.secret_id.equals(id))
        .limit(1);

      if (!remaining[0]) {
        await client.unsafe(`DELETE FROM secret WHERE id = $1`, [id]);
      }

      return (result as any).count > 0;
    },
  };
}
