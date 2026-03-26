import { describe, test, expect, afterEach } from "bun:test";
import { createKeyManager, type KeyStore, type StoredKey, type KeyManager } from "./key-manager";
import { jwtVerify, createLocalJWKSet } from "jose";

// In-memory KeyStore for testing (no DB needed)
function createMemoryKeyStore(): KeyStore & { keys: StoredKey[] } {
  const keys: StoredKey[] = [];
  return {
    keys,
    async loadKeys() {
      return keys.filter((k) => k.status !== "revoked");
    },
    async insertKey(key: StoredKey) {
      keys.push(key);
    },
    async deprecateAllActive() {
      for (const k of keys) {
        if (k.status === "active") k.status = "deprecated";
      }
    },
    async cleanupExpired() {
      const now = Date.now();
      const before = keys.length;
      const remaining = keys.filter((k) => k.expiresAt.getTime() > now);
      keys.length = 0;
      keys.push(...remaining);
      return before - remaining.length;
    },
  };
}

describe("KeyManager", () => {
  let km: KeyManager;

  afterEach(() => {
    km?.stop();
  });

  test("creates initial key on startup", async () => {
    const store = createMemoryKeyStore();
    km = await createKeyManager({
      store,
      issuer: "http://test:3000",
      checkIntervalMs: 60_000,
    });

    const jwks = km.getJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].alg).toBe("ES256");
    expect(jwks.keys[0].kid).toMatch(/^key-/);
    // No private key exposed
    expect(jwks.keys[0].d).toBeUndefined();
  });

  test("signs a valid JWT", async () => {
    const store = createMemoryKeyStore();
    km = await createKeyManager({
      store,
      issuer: "http://test:3000",
      checkIntervalMs: 60_000,
    });

    const token = await km.signJwt({ sub: "test-service" });
    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString()
    );
    expect(payload.sub).toBe("test-service");
    expect(payload.iss).toBe("http://test:3000");
    expect(payload.exp - payload.iat).toBe(300); // default 5 min TTL
  });

  test("token verifies against JWKS", async () => {
    const store = createMemoryKeyStore();
    km = await createKeyManager({
      store,
      issuer: "http://test:3000",
      checkIntervalMs: 60_000,
    });

    const token = await km.signJwt({ sub: "verify-me" });
    const jwks = km.getJwks();
    const JWKS = createLocalJWKSet(jwks);
    const { payload } = await jwtVerify(token, JWKS);
    expect(payload.sub).toBe("verify-me");
  });

  test("custom token TTL", async () => {
    const store = createMemoryKeyStore();
    km = await createKeyManager({
      store,
      issuer: "http://test:3000",
      tokenTtlSeconds: 60,
      checkIntervalMs: 60_000,
    });

    const token = await km.signJwt({ sub: "short-lived" });
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString()
    );
    expect(payload.exp - payload.iat).toBe(60);
  });

  // ---- Rotation tests ----

  test("rotation: creates new key when threshold exceeded", async () => {
    const store = createMemoryKeyStore();
    km = await createKeyManager({
      store,
      issuer: "http://test:3000",
      rotationThresholdMs: 0, // immediate rotation
      checkIntervalMs: 60_000,
    });

    const initialKid = km.getJwks().keys.find(
      (k) => store.keys.find((sk) => sk.kid === k.kid)?.status === "active"
    )?.kid;

    // Force rotation
    await km.rotate();

    const activeKeys = store.keys.filter((k) => k.status === "active");
    expect(activeKeys).toHaveLength(1);
    expect(activeKeys[0].kid).not.toBe(initialKid);

    const deprecatedKeys = store.keys.filter((k) => k.status === "deprecated");
    expect(deprecatedKeys.length).toBeGreaterThanOrEqual(1);
  });

  test("rotation: deprecated keys still in JWKS for verification", async () => {
    const store = createMemoryKeyStore();
    km = await createKeyManager({
      store,
      issuer: "http://test:3000",
      rotationThresholdMs: 0,
      checkIntervalMs: 60_000,
    });

    await km.rotate();

    const jwksKids = km.getJwks().keys.map((k) => k.kid);
    const nonRevoked = store.keys.filter((k) => k.status !== "revoked");
    for (const key of nonRevoked) {
      expect(jwksKids).toContain(key.kid);
    }
  });

  test("rotation: pre-rotation tokens still verify", async () => {
    const store = createMemoryKeyStore();
    km = await createKeyManager({
      store,
      issuer: "http://test:3000",
      rotationThresholdMs: 0,
      checkIntervalMs: 60_000,
    });

    const preRotationToken = await km.signJwt({ sub: "pre-rotate" });
    await km.rotate();

    // Pre-rotation token should still verify (deprecated key still in JWKS)
    const jwks = km.getJwks();
    const JWKS = createLocalJWKSet(jwks);
    const { payload } = await jwtVerify(preRotationToken, JWKS);
    expect(payload.sub).toBe("pre-rotate");
  });

  test("rotation: exactly 1 active key", async () => {
    const store = createMemoryKeyStore();
    km = await createKeyManager({
      store,
      issuer: "http://test:3000",
      rotationThresholdMs: 0,
      checkIntervalMs: 60_000,
    });

    await km.rotate();
    await km.rotate();

    const activeKeys = store.keys.filter((k) => k.status === "active");
    expect(activeKeys).toHaveLength(1);
  });

  // ---- enableRotation option ----

  test("enableRotation: false skips background interval", async () => {
    const store = createMemoryKeyStore();
    km = await createKeyManager({
      store,
      issuer: "http://test:3000",
      enableRotation: false,
    });

    // Should still have an initial key
    expect(km.getJwks().keys).toHaveLength(1);
    // But stop() should be a no-op (no interval to clear)
    km.stop();
  });
});
