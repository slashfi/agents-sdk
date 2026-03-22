/**
 * JWKS key management for asymmetric JWT signing.
 *
 * Each registry generates an ES256 key pair. JWTs are signed with the private key.
 * Public keys are exposed via /.well-known/jwks.json.
 * Key rotation: new key generated, old key kept for verification during overlap period.
 */
import * as jose from 'jose';

export interface KeyPair {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  createdAt: number;
  /** If set, this key should not be used for signing after this time */
  retiredAt?: number;
}

export interface SerializedKeyPair {
  kid: string;
  privateKeyJwk: jose.JWK;
  publicKeyJwk: jose.JWK;
  createdAt: number;
  retiredAt?: number;
}

export interface KeyStore {
  /** Load all stored key pairs */
  loadKeys(): Promise<SerializedKeyPair[]>;
  /** Save key pairs (replace all) */
  saveKeys(keys: SerializedKeyPair[]): Promise<void>;
}

export interface KeyManagerOptions {
  /** Key store for persistence. If not provided, keys are in-memory only. */
  store?: KeyStore;
  /** Algorithm for key generation. Default: ES256 */
  algorithm?: string;
  /** How long before a key is rotated. Default: 30 days */
  rotationInterval?: number;
  /** How long old keys are kept for verification after rotation. Default: 7 days */
  overlapPeriod?: number;
}

const DEFAULT_ROTATION_INTERVAL = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_OVERLAP_PERIOD = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateKid(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export class KeyManager {
  private keys: KeyPair[] = [];
  private store?: KeyStore;
  private algorithm: string;
  private rotationInterval: number;
  private overlapPeriod: number;
  private initialized = false;

  constructor(options: KeyManagerOptions = {}) {
    this.store = options.store;
    this.algorithm = options.algorithm ?? 'ES256';
    this.rotationInterval = options.rotationInterval ?? DEFAULT_ROTATION_INTERVAL;
    this.overlapPeriod = options.overlapPeriod ?? DEFAULT_OVERLAP_PERIOD;
  }

  /** Initialize: load keys from store or generate first key pair */
  async init(): Promise<void> {
    if (this.initialized) return;

    if (this.store) {
      const stored = await this.store.loadKeys();
      for (const sk of stored) {
        const privateKey = await jose.importJWK(sk.privateKeyJwk, this.algorithm);
        const publicKey = await jose.importJWK(sk.publicKeyJwk, this.algorithm);
        this.keys.push({
          kid: sk.kid,
          privateKey: privateKey as CryptoKey,
          publicKey: publicKey as CryptoKey,
          createdAt: sk.createdAt,
          retiredAt: sk.retiredAt,
        });
      }
    }

    // Generate first key if none exist
    if (this.keys.length === 0) {
      await this.generateKey();
    }

    this.initialized = true;
  }

  /** Generate a new key pair and make it the active signing key */
  async generateKey(): Promise<KeyPair> {
    const kid = `key-${generateKid()}`;
    const { publicKey, privateKey } = await jose.generateKeyPair(this.algorithm, {
      extractable: true,
    });
    const kp: KeyPair = {
      kid,
      privateKey: privateKey as CryptoKey,
      publicKey: publicKey as CryptoKey,
      createdAt: Date.now(),
    };
    this.keys.push(kp);
    await this.persist();
    return kp;
  }

  /** Get the active signing key (most recent non-retired key) */
  getSigningKey(): KeyPair {
    const now = Date.now();
    // Find most recent key that isn't retired
    const active = this.keys
      .filter(k => !k.retiredAt || k.retiredAt > now)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (active.length === 0) {
      throw new Error('No active signing key available');
    }
    return active[0];
  }

  /** Get all keys for verification (including retired ones within overlap period) */
  getVerificationKeys(): KeyPair[] {
    const now = Date.now();
    return this.keys.filter(k => {
      if (!k.retiredAt) return true;
      // Keep retired keys for overlap period
      return now - k.retiredAt < this.overlapPeriod;
    });
  }

  /** Export public keys as JWKS */
  async exportJWKS(): Promise<jose.JSONWebKeySet> {
    const keys: jose.JWK[] = [];
    for (const kp of this.getVerificationKeys()) {
      const jwk = await jose.exportJWK(kp.publicKey);
      jwk.kid = kp.kid;
      jwk.alg = this.algorithm;
      jwk.use = 'sig';
      keys.push(jwk);
    }
    return { keys };
  }

  /** Sign a JWT with the active signing key */
  async signJwt(
    claims: Record<string, unknown>,
    options?: { expiresIn?: string | number },
  ): Promise<string> {
    await this.init();
    const signingKey = this.getSigningKey();
    let builder = new jose.SignJWT(claims as jose.JWTPayload)
      .setProtectedHeader({ alg: this.algorithm, kid: signingKey.kid })
      .setIssuedAt();

    if (options?.expiresIn) {
      if (typeof options.expiresIn === 'string') {
        builder = builder.setExpirationTime(options.expiresIn);
      } else {
        builder = builder.setExpirationTime(Math.floor(Date.now() / 1000) + options.expiresIn);
      }
    }

    return builder.sign(signingKey.privateKey);
  }

  /** Verify a JWT against any of our verification keys */
  async verifyJwt(token: string): Promise<jose.JWTPayload | null> {
    await this.init();
    const verificationKeys = this.getVerificationKeys();

    // Try to extract kid from header
    try {
      const header = jose.decodeProtectedHeader(token);
      if (header.kid) {
        const key = verificationKeys.find(k => k.kid === header.kid);
        if (key) {
          const { payload } = await jose.jwtVerify(token, key.publicKey);
          return payload;
        }
      }
    } catch {
      // Fall through to try all keys
    }

    // Try all verification keys
    for (const key of verificationKeys) {
      try {
        const { payload } = await jose.jwtVerify(token, key.publicKey);
        return payload;
      } catch {
        continue;
      }
    }

    return null;
  }

  /** Rotate keys: retire current signing key, generate new one, prune expired */
  async rotate(): Promise<void> {
    const now = Date.now();

    // Retire all non-retired keys
    for (const k of this.keys) {
      if (!k.retiredAt) k.retiredAt = now;
    }

    // Generate new signing key
    await this.generateKey();

    // Prune keys that are past the overlap period
    this.keys = this.keys.filter(k => {
      if (!k.retiredAt) return true;
      return now - k.retiredAt < this.overlapPeriod;
    });

    await this.persist();
  }

  /** Check if rotation is needed based on the rotation interval */
  needsRotation(): boolean {
    const signingKey = this.keys
      .filter(k => !k.retiredAt)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!signingKey) return true;
    return Date.now() - signingKey.createdAt > this.rotationInterval;
  }

  private async persist(): Promise<void> {
    if (!this.store) return;
    const serialized: SerializedKeyPair[] = [];
    for (const kp of this.keys) {
      serialized.push({
        kid: kp.kid,
        privateKeyJwk: await jose.exportJWK(kp.privateKey),
        publicKeyJwk: await jose.exportJWK(kp.publicKey),
        createdAt: kp.createdAt,
        retiredAt: kp.retiredAt,
      });
    }
    await this.store.saveKeys(serialized);
  }
}

/** Create an in-memory key store (for development/testing) */
export function createMemoryKeyStore(): KeyStore {
  let stored: SerializedKeyPair[] = [];
  return {
    async loadKeys() { return stored; },
    async saveKeys(keys) { stored = keys; },
  };
}
