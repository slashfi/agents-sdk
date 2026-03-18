/**
 * Secrets - encrypted secret storage and resolution for tool params.
 *
 * Secrets are stored encrypted and referenced via `secret:<id>` strings.
 * The SDK automatically:
 * - Resolves `secret:xxx` refs in tool params before execution
 * - Stores raw values in `secret: true` schema fields and replaces with refs
 * - Redacts secrets from tool results in LLM context
 */


// ============================================
// SecretStore Interface
// ============================================

export interface SecretStore {
  /** Store a secret value. Returns the secret ref (e.g., "secret:abc123"). */
  store(value: string, ownerId: string): Promise<string>;

  /** Resolve a secret ref to its value. Returns null if not found or unauthorized. */
  resolve(ref: string, ownerId: string): Promise<string | null>;

  /** Delete a secret. */
  delete(ref: string, ownerId: string): Promise<boolean>;
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

export function createInMemorySecretStore(): SecretStore {
  const secrets = new Map<string, { value: string; ownerId: string }>();

  return {
    async store(value, ownerId) {
      const id = randomSecretId();
      secrets.set(id, { value, ownerId });
      return makeSecretRef(id);
    },

    async resolve(ref, ownerId) {
      const id = getSecretId(ref);
      const entry = secrets.get(id);
      if (!entry || entry.ownerId !== ownerId) return null;
      return entry.value;
    },

    async delete(ref, ownerId) {
      const id = getSecretId(ref);
      const entry = secrets.get(id);
      if (!entry || entry.ownerId !== ownerId) return false;
      secrets.delete(id);
      return true;
    },
  };
}

// ============================================
// Param Resolution
// ============================================

interface SchemaProperty {
  type?: string;
  secret?: boolean;
  properties?: Record<string, SchemaProperty>;
}

/**
 * Walk tool params, resolve `secret:xxx` refs and store raw secret values.
 *
 * - If a param value is `secret:xxx`, resolve it from the store.
 * - If a param has `secret: true` in schema and value is a raw string,
 *   store it and replace with a ref (for logging/context).
 *
 * Returns: { resolved: params with real values for tool execution,
 *            redacted: params with refs for logging }
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

    // Recurse into nested objects
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

    // Case 1: Value is already a secret ref - resolve it
    if (isSecretRef(value)) {
      const realValue = await secretStore.resolve(value, ownerId);
      if (realValue === null) {
        throw new Error(`Secret not found or unauthorized: ${value}`);
      }
      resolved[key] = realValue;
      redacted[key] = value; // keep the ref in redacted version
      continue;
    }

    // Case 2: Schema says this field is secret + value is raw - store it
    if (schemaProp.secret && (value as string).length > 0) {
      const ref = await secretStore.store(value, ownerId);
      resolved[key] = value; // tool gets the real value
      redacted[key] = ref;   // logs/context get the ref
      continue;
    }
  }

  return { resolved, redacted };
}
