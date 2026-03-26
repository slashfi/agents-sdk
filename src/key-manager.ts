/**
 * JWKS Key Manager
 *
 * Manages ES256 signing keys with automatic rotation and revocation.
 * Store-agnostic — provide a KeyStore implementation for your DB.
 *
 * Features:
 * - Automatic key rotation on a configurable schedule
 * - Key lifecycle: active → deprecated → revoked → cleaned up
 * - Multi-instance safe: checks DB before rotating (another instance may have already rotated)
 * - Periodic background checks (configurable interval)
 * - Exposes JWKS for /.well-known/jwks.json
 * - Signs JWTs with the active key
 */

import {
  generateKeyPair,
  exportJWK,
  importJWK,
  SignJWT,
  type JWK,
} from "jose";

// ── Types ──

export type KeyStatus = "active" | "deprecated" | "revoked";

export interface StoredKey {
  kid: string;
  alg: string;
  status: KeyStatus;
  publicJwk: JWK;
  privateJwk: JWK;
  createdAt: Date;
  expiresAt: Date;
}

interface CachedKey extends StoredKey {
  privateKey: CryptoKey;
}

/**
 * Pluggable store interface for key persistence.
 * Implement this for your database (CockroachDB, Postgres, SQLite, etc.)
 */
export interface KeyStore {
  /** Load all non-revoked keys */
  loadKeys(): Promise<StoredKey[]>;
  /** Insert a new key */
  insertKey(key: StoredKey): Promise<void>;
  /** Set all active keys to deprecated */
  deprecateAllActive(): Promise<void>;
  /** Delete expired keys, return count deleted */
  cleanupExpired(): Promise<number>;
  /**
   * Run operations atomically. Implementations with transaction support
   * should wrap the callback in a DB transaction to ensure rotate() is
   * atomic (load + deprecate + insert + cleanup all succeed or all fail).
   * For stores without real tx support, pass a no-op wrapper that runs fn sequentially.
   */
  transaction<T>(fn: (store: Pick<KeyStore, "loadKeys" | "insertKey" | "deprecateAllActive" | "cleanupExpired">) => Promise<T>): Promise<T>;
}

export interface KeyManager {
  /** Get the JWKS for /.well-known/jwks.json */
  getJwks(): { keys: JWK[] };
  /** Sign a JWT with the active key */
  signJwt(claims: Record<string, unknown>): Promise<string>;
  /** Force a key rotation */
  rotate(): Promise<void>;
  /** Stop the background rotation check */
  stop(): void;
}

export interface KeyManagerOptions {
  /** Key store implementation */
  store: KeyStore;
  /** Issuer URL for the iss claim */
  issuer: string;
  /** How often to check if rotation is needed (default: 5 min) */
  checkIntervalMs?: number;
  /** Max age of an active key before rotation (default: 1 hour) */
  rotationThresholdMs?: number;
  /** How long deprecated keys stay in JWKS for verification (default: 2 hours) */
  keyLifetimeMs?: number;
  /** Token TTL in seconds (default: 300 = 5 min) */
  tokenTtlSeconds?: number;
  /** Enable background key rotation (default: true). Set to false on read-only replicas. */
  enableRotation?: boolean;
}

// ── Constants ──

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const TWO_HOURS = 2 * ONE_HOUR;
const ALG = "ES256";

// ── Key generation ──

function generateKid(): string {
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function generateNewKey(keyLifetimeMs: number): Promise<StoredKey> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
  const kid = generateKid();

  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = ALG;
  publicJwk.use = "sig";

  const privateJwk = await exportJWK(privateKey);
  privateJwk.kid = kid;
  privateJwk.alg = ALG;

  return {
    kid,
    alg: ALG,
    status: "active",
    publicJwk,
    privateJwk,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + keyLifetimeMs),
  };
}

async function toCachedKey(stored: StoredKey): Promise<CachedKey> {
  const privateKey = await importJWK(stored.privateJwk, ALG) as CryptoKey;
  return { ...stored, privateKey };
}

// ── Key Manager ──

export async function createKeyManager(opts: KeyManagerOptions): Promise<KeyManager> {
  const {
    store,
    issuer,
    checkIntervalMs = FIVE_MINUTES,
    rotationThresholdMs = ONE_HOUR,
    keyLifetimeMs = TWO_HOURS,
    tokenTtlSeconds = 300,
    enableRotation = true,
  } = opts;

  let keys: CachedKey[] = [];

  /** Refresh in-memory cache from store */
  async function refresh(): Promise<void> {
    const stored = await store.loadKeys();
    keys = await Promise.all(stored.map(toCachedKey));
  }

  /** Generate a new key, deprecate old ones, cleanup expired — runs inside store.transaction() for atomicity */
  async function rotate(): Promise<void> {
    const newKey = await generateNewKey(keyLifetimeMs);
    await store.transaction(async (tx) => {
      await tx.deprecateAllActive();
      await tx.insertKey(newKey);
      await tx.cleanupExpired();
    });
    await refresh();
  }

  /** Check if rotation is needed and rotate if so — all within a single transaction */
  async function checkAndRotate(): Promise<void> {
    // Quick check against cache — no DB/store hit if key is fresh
    const cached = keys.find((k) => k.status === "active");
    if (cached) {
      const age = Date.now() - cached.createdAt.getTime();
      if (age < rotationThresholdMs) return;
    }

    // Cache says stale (or empty) — take a lock via transaction to check + rotate atomically
    await store.transaction(async (tx) => {
      const stored = await tx.loadKeys();
      const active = stored.find((k) => k.status === "active");

      if (active) {
        const age = Date.now() - active.createdAt.getTime();
        if (age < rotationThresholdMs) {
          // Another instance already rotated — just update our cache
          keys = await Promise.all(stored.map(toCachedKey));
          return;
        }
      }

      // Still stale (or no active key) — rotate within this tx
      const newKey = await generateNewKey(keyLifetimeMs);
      await tx.deprecateAllActive();
      await tx.insertKey(newKey);
      await tx.cleanupExpired();

      // Refresh cache inside the tx for a consistent read
      const updated = await tx.loadKeys();
      keys = await Promise.all(updated.map(toCachedKey));
    });
  }

  // Initial load + ensure we have at least one key
  await refresh();
  if (!keys.some((k) => k.status === "active")) {
    if (enableRotation) {
      await rotate();
    } else {
      // Read-only mode: generate a key in memory only (no store writes)
      // This ensures signJwt works even without rotation enabled
      const { generateKeyPair: gkp, exportJWK: eJWK } = await import("jose");
      const { privateKey, publicKey } = await gkp("ES256", { extractable: true });
      const kid = `key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pubJwk = await eJWK(publicKey); pubJwk.kid = kid; pubJwk.alg = "ES256"; pubJwk.use = "sig";
      const privJwk = await eJWK(privateKey); privJwk.kid = kid; privJwk.alg = "ES256";
      const pk = await (await import("jose")).importJWK(privJwk, "ES256") as CryptoKey;
      keys.push({ kid, alg: "ES256", status: "active", publicJwk: pubJwk, privateJwk: privJwk, createdAt: new Date(), expiresAt: new Date(Date.now() + keyLifetimeMs), privateKey: pk });
    }
  } else if (enableRotation) {
    await checkAndRotate();
  }

  // Periodic background check (only if rotation enabled)
  const interval = enableRotation
    ? setInterval(async () => {
        try {
          await checkAndRotate();
        } catch (err) {
          console.error("[key-manager] Check/rotation failed:", err);
        }
      }, checkIntervalMs)
    : null;

  function getActiveKey(): CachedKey {
    const active = keys.find((k) => k.status === "active");
    if (!active) throw new Error("[key-manager] No active signing key");
    return active;
  }

  return {
    getJwks(): { keys: JWK[] } {
      return {
        keys: keys
          .filter((k) => k.status !== "revoked")
          .map((k) => k.publicJwk),
      };
    },

    async signJwt(claims: Record<string, unknown>): Promise<string> {
      const key = getActiveKey();
      return new SignJWT({ ...claims } as any)
        .setProtectedHeader({ alg: ALG, kid: key.kid })
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime(`${tokenTtlSeconds}s`)
        .sign(key.privateKey);
    },

    async rotate(): Promise<void> {
      await rotate();
    },

    stop(): void {
      if (interval) clearInterval(interval);
    },
  };
}
