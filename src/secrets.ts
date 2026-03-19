/**
 * Secrets - encrypted secret storage and resolution for tool params.
 *
 * Provides:
 * - SecretStore interface for pluggable storage backends
 * - createSecretsAgent: built-in @secrets agent with store/resolve tools
 * - processSecretParams: auto-resolve secret:xxx refs in tool params
 * - AES-256-GCM encryption via crypto.ts
 */

import { encryptSecret, decryptSecret } from "./crypto.js";
import { defineAgent, defineTool } from "./define.js";
import type { AgentDefinition, ToolContext, ToolDefinition } from "./types.js";

// ============================================
// SecretStore Interface
// ============================================

/**
 * Pluggable secret storage backend.
 * Stores encrypted values, resolves refs.
 */
export interface SecretStore {
  /** Store a secret. Returns the secret ID (without prefix). */
  store(value: string, ownerId: string): Promise<string>;
  /** Resolve a secret ID to its decrypted value. */
  resolve(id: string, ownerId: string): Promise<string | null>;
  /** Delete a secret. */
  delete(id: string, ownerId: string): Promise<boolean>;
}

// ============================================
// Secret Ref Helpers
// ============================================

const SECRET_PREFIX = "secret:";

export function isSecretRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SECRET_PREFIX);
}

export function getSecretId(ref: string): string {
  return ref.slice(SECRET_PREFIX.length);
}

export function makeSecretRef(id: string): string {
  return `${SECRET_PREFIX}${id}`;
}

function randomSecretId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 24; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ============================================
// In-Memory SecretStore (default)
// ============================================

export function createInMemorySecretStore(encryptionKey: string): SecretStore {
  const secrets = new Map<string, { encrypted: string; ownerId: string }>();

  return {
    async store(value, ownerId) {
      const id = randomSecretId();
      const encrypted = await encryptSecret(value, encryptionKey);
      secrets.set(id, { encrypted, ownerId });
      return id;
    },

    async resolve(id, ownerId) {
      const entry = secrets.get(id);
      if (!entry || entry.ownerId !== ownerId) return null;
      return decryptSecret(entry.encrypted, encryptionKey);
    },

    async delete(id, ownerId) {
      const entry = secrets.get(id);
      if (!entry || entry.ownerId !== ownerId) return false;
      secrets.delete(id);
      return true;
    },
  };
}

// ============================================
// createSecretsAgent
// ============================================

export interface SecretsAgentOptions {
  /** Secret store backend */
  store: SecretStore;
}

/**
 * Create the built-in @secrets agent.
 * Provides tools for storing and resolving secrets via MCP.
 */
export function createSecretsAgent(
  options: SecretsAgentOptions,
): AgentDefinition {
  const { store } = options;

  const storeSecretTool = defineTool({
    name: "store",
    description: "Store secret values. Returns secret:<id> refs for each value.",
    visibility: "internal" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        secrets: {
          type: "object" as const,
          description: "Key-value pairs to store as secrets",
          additionalProperties: { type: "string" },
        },
      },
      required: ["secrets"],
    },
    execute: async (input: { secrets: Record<string, string> }, ctx: ToolContext) => {
      const ownerId = ctx.callerId ?? "anonymous";
      const refs: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.secrets)) {
        if (typeof value === "string" && value.length > 0) {
          const id = await store.store(value, ownerId);
          refs[key] = makeSecretRef(id);
        }
      }
      return { refs };
    },
  });

  const resolveSecretTool = defineTool({
    name: "resolve",
    description: "Resolve a secret ref to its value. Only accessible to the owner.",
    visibility: "internal" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        ref: { type: "string" as const, description: "Secret ref (secret:xxx)" },
      },
      required: ["ref"],
    },
    execute: async (input: { ref: string }, ctx: ToolContext) => {
      const ownerId = ctx.callerId ?? "anonymous";
      const id = getSecretId(input.ref);
      const value = await store.resolve(id, ownerId);
      if (!value) throw new Error("Secret not found or unauthorized");
      // Return wrapped so actor can handle it
      return { value: { $agent_type: "secret", value } };
    },
  });

  const revokeSecretTool = defineTool({
    name: "revoke",
    description: "Delete a stored secret.",
    visibility: "internal" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        ref: { type: "string" as const, description: "Secret ref to revoke" },
      },
      required: ["ref"],
    },
    execute: async (input: { ref: string }, ctx: ToolContext) => {
      const ownerId = ctx.callerId ?? "anonymous";
      const id = getSecretId(input.ref);
      const deleted = await store.delete(id, ownerId);
      return { deleted };
    },
  });

  return defineAgent({
    path: "@secrets",
    entrypoint: "Secret storage agent. Stores, resolves, and manages encrypted secrets.",
    config: {
      name: "Secrets",
      description: "Encrypted secret storage and management",
      visibility: "internal",
    },
    tools: [storeSecretTool, resolveSecretTool, revokeSecretTool] as ToolDefinition<ToolContext>[],
  });
}

// ============================================
// Param Resolution (used by server)
// ============================================

interface SchemaProperty {
  type?: string;
  secret?: boolean;
  properties?: Record<string, SchemaProperty>;
}

/**
 * Process tool params: resolve secret:xxx refs and store raw secret values.
 */
export async function processSecretParams(
  params: Record<string, unknown>,
  schema: { properties?: Record<string, SchemaProperty> } | undefined,
  secretStore: SecretStore,
  ownerId: string,
): Promise<{ resolved: Record<string, unknown>; redacted: Record<string, unknown> }> {
  const resolved: Record<string, unknown> = { ...params };
  const redacted: Record<string, unknown> = { ...params };

  if (!schema?.properties) return { resolved, redacted };

  for (const [key, schemaProp] of Object.entries(schema.properties)) {
    const value = params[key];
    if (value === undefined || value === null) continue;

    if (schemaProp.type === "object" && typeof value === "object" && !Array.isArray(value)) {
      const nested = await processSecretParams(
        value as Record<string, unknown>,
        schemaProp,
        secretStore,
        ownerId,
      );
      resolved[key] = nested.resolved;
      redacted[key] = nested.redacted;
      continue;
    }

    if (typeof value !== "string") continue;

    // Resolve secret refs
    if (isSecretRef(value)) {
      const id = getSecretId(value);
      const realValue = await secretStore.resolve(id, ownerId);
      if (realValue === null) throw new Error(`Secret not found: ${value}`);
      resolved[key] = realValue;
      redacted[key] = value;
      continue;
    }

    // Auto-store raw values in secret: true fields
    if (schemaProp.secret && (value as string).length > 0) {
      const id = await secretStore.store(value, ownerId);
      resolved[key] = value;
      redacted[key] = makeSecretRef(id);
      continue;
    }
  }

  return { resolved, redacted };
}
