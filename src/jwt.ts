/**
 * JWT utilities for auth tokens.
 *
 * Minimal JWT implementation using Web Crypto API (HMAC-SHA256).
 * No external dependencies.
 */

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
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

async function hmacVerify(
  data: string,
  signature: Uint8Array,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature.buffer as ArrayBuffer,
    encoder.encode(data),
  );
}

/** JWT payload for auth tokens */
export interface JwtPayload {
  /** Subject - the client ID */
  sub: string;
  /** Client name */
  name: string;
  /** Tenant ID */
  tenantId?: string;
  /** Scopes */
  scopes: string[];
  /** Issued at (unix seconds) */
  iat: number;
  /** Expires at (unix seconds) */
  exp: number;
}

/**
 * Sign a JWT with HMAC-SHA256.
 *
 * @param payload - JWT payload (client_id, scopes, etc.)
 * @param secret - Signing secret (the client's secret hash)
 * @returns Signed JWT string
 */
export async function signJwt(
  payload: JwtPayload,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };

  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await hmacSign(signingInput, secret);
  const signatureB64 = base64UrlEncode(signature);

  return `${signingInput}.${signatureB64}`;
}

/**
 * Verify and decode a JWT.
 *
 * @param token - JWT string
 * @param secret - Signing secret to verify against
 * @returns Decoded payload, or null if invalid/expired
 */
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<JwtPayload | null> {
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
    ) as JwtPayload;

    // Check expiration
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
