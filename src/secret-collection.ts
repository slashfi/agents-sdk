/**
 * Secret Collection
 *
 * Manages pending secret collection forms (one-time tokens).
 * Used by @integrations collect_secrets and the server's /secrets/collect endpoint.
 *
 * Exported for use in custom server implementations.
 */

// ============================================
// Types
// ============================================

export interface PendingCollectionField {
  name: string;
  description?: string;
  required: boolean;
  secret: boolean;
}

export interface PendingCollection {
  agent: string;
  tool: string;
  params: Record<string, unknown>;
  fields: PendingCollectionField[];
  auth?: {
    callerId: string;
    callerType: string;
    scopes?: string[];
  };
  createdAt: number;
}

// ============================================
// Storage (with TTL cleanup)
// ============================================

/** Default TTL for pending collections: 15 minutes */
const COLLECTION_TTL_MS = 15 * 60 * 1000;

/** Pending secret collection forms, keyed by one-time token */
export const pendingCollections = new Map<string, PendingCollection>();

/** Generate a random one-time token for secret collection */
export function generateCollectionToken(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 48; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

/**
 * Clean up expired pending collections.
 * Call this periodically or before lookups.
 */
export function cleanupExpiredCollections(): void {
  const now = Date.now();
  for (const [token, pending] of pendingCollections) {
    if (now - pending.createdAt > COLLECTION_TTL_MS) {
      pendingCollections.delete(token);
    }
  }
}
