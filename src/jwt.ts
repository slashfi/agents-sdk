/**
 * JWT utilities for auth tokens.
 *
 * Supports two modes:
 * - ES256 (asymmetric) — for production / cross-registry trust
 * - HS256 (HMAC) — for backward compat / simple single-server setups
 *
 * Uses `jose` library for all crypto operations.
 */

import {
  SignJWT,
  jwtVerify,
  generateKeyPair,
  exportJWK,
  importJWK,
  createRemoteJWKSet,
  type JWTPayload,

  type JWK,
} from "jose";

// ============================================
// Types
// ============================================

/** JWT payload for auth tokens */
export interface AgentJwtPayload {
  /** Subject - the client ID or user ID */
  sub: string;
  /** Client/user name */
  name: string;
  /** Issuer URL */
  iss?: string;
  /** Tenant ID */
  tenantId?: string;
  /** User ID (when acting on behalf of a user) */
  userId?: string;
  /** Scopes */
  scopes: string[];
  /** Identities (for cross-registry provisioning) */
  identities?: Array<{ provider: string; id: string; [key: string]: unknown }>;
  /** Issued at (unix seconds) */
  iat: number;
  /** Expires at (unix seconds) */
  exp: number;
}

/** A signing key with metadata */
export interface SigningKey {
  /** Unique key ID */
  kid: string;
  /** Private key (for signing) */
  privateKey: CryptoKey;
  /** Public key (for verification + JWKS) */
  publicKey: CryptoKey;
  /** Algorithm */
  alg: string;
  /** Status */
  status: "active" | "deprecated" | "revoked";
  /** When this key was created */
  createdAt: number;
}

/** Exported key pair for storage */
export interface ExportedKeyPair {
  kid: string;
  alg: string;
  privateKeyJwk: JWK;
  publicKeyJwk: JWK;
  status: "active" | "deprecated" | "revoked";
  createdAt: number;
}

// ============================================
// Key Generation
// ============================================

/**
 * Generate a new ES256 signing key pair.
 */
export async function generateSigningKey(kid?: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  return {
    kid: kid ?? `key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    privateKey,
    publicKey,
    alg: "ES256",
    status: "active",
    createdAt: Date.now(),
  };
}

/**
 * Export a signing key to JWK format (for storage).
 */
export async function exportSigningKey(key: SigningKey): Promise<ExportedKeyPair> {
  const privateKeyJwk = await exportJWK(key.privateKey);
  const publicKeyJwk = await exportJWK(key.publicKey);
  return {
    kid: key.kid,
    alg: key.alg,
    privateKeyJwk,
    publicKeyJwk,
    status: key.status,
    createdAt: key.createdAt,
  };
}

/**
 * Import a signing key from stored JWK format.
 */
export async function importSigningKey(exported: ExportedKeyPair): Promise<SigningKey> {
  const privateKey = await importJWK(exported.privateKeyJwk, exported.alg) as CryptoKey;
  const publicKey = await importJWK(exported.publicKeyJwk, exported.alg) as CryptoKey;
  return {
    kid: exported.kid,
    privateKey,
    publicKey,
    alg: exported.alg,
    status: exported.status,
    createdAt: exported.createdAt,
  };
}

/**
 * Build a JWKS (JSON Web Key Set) from signing keys.
 * Only includes public keys.
 */
export async function buildJwks(keys: SigningKey[]): Promise<{ keys: JWK[] }> {
  const jwks: JWK[] = [];
  for (const key of keys) {
    if (key.status === "revoked") continue;
    const jwk = await exportJWK(key.publicKey);
    jwk.kid = key.kid;
    jwk.alg = key.alg;
    jwk.use = "sig";
    jwks.push(jwk);
  }
  return { keys: jwks };
}

// ============================================
// Signing (ES256)
// ============================================

/**
 * Sign a JWT with ES256 using the server's private key.
 */
export async function signJwtES256(
  payload: Omit<AgentJwtPayload, "iat" | "exp"> & { iat?: number; exp?: number },
  privateKey: CryptoKey,
  kid: string,
  issuer?: string,
  expiresIn?: string,
): Promise<string> {
  let builder = new SignJWT(payload as unknown as JWTPayload)
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuedAt();

  if (issuer) builder = builder.setIssuer(issuer);
  if (payload.sub) builder = builder.setSubject(payload.sub);
  if (expiresIn) {
    builder = builder.setExpirationTime(expiresIn);
  } else if (payload.exp) {
    builder = builder.setExpirationTime(payload.exp);
  } else {
    builder = builder.setExpirationTime("1h");
  }

  return builder.sign(privateKey);
}

// ============================================
// Verification
// ============================================

/**
 * Verify a JWT against a local public key.
 */
export async function verifyJwtLocal(
  token: string,
  publicKey: CryptoKey,
): Promise<AgentJwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, publicKey);
    return payload as unknown as AgentJwtPayload;
  } catch {
    return null;
  }
}

/** JWKS cache for remote issuers */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Verify a JWT against a remote issuer's JWKS.
 * Fetches and caches the JWKS from the issuer's /.well-known/jwks.json
 */
export async function verifyJwtFromIssuer(
  token: string,
  issuerUrl: string,
): Promise<AgentJwtPayload | null> {
  try {
    const jwksUrl = issuerUrl.replace(/\/$/, "") + "/.well-known/jwks.json";
    let jwks = jwksCache.get(jwksUrl);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(jwksUrl));
      jwksCache.set(jwksUrl, jwks);
    }
    const { payload } = await jwtVerify(token, jwks);
    return payload as unknown as AgentJwtPayload;
  } catch {
    return null;
  }
}

// ============================================
// Legacy HMAC (backward compat)
// ============================================

const encoder = new TextEncoder();

function base64UrlEncode(data: Uint8Array): string {
  const str = btoa(String.fromCharCode(...data));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacSign(data: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

async function hmacVerify(data: string, signature: Uint8Array, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature.buffer as ArrayBuffer, encoder.encode(data));
}

/** @deprecated Use AgentJwtPayload instead */
export type JwtPayload = AgentJwtPayload;

/**
 * Sign a JWT with HMAC-SHA256 (legacy).
 * @deprecated Use signJwtES256 for new code.
 */
export async function signJwt(
  payload: AgentJwtPayload,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await hmacSign(signingInput, secret);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/**
 * Verify and decode a JWT (HMAC-SHA256, legacy).
 * @deprecated Use verifyJwtLocal or verifyJwtFromIssuer for new code.
 */
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<AgentJwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  try {
    const signature = base64UrlDecode(signatureB64);
    const valid = await hmacVerify(signingInput, signature, secret);
    if (!valid) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64)),
    ) as AgentJwtPayload;
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
