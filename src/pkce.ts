/**
 * PKCE (Proof Key for Code Exchange) utilities.
 *
 * RFC 7636 — used by MCP client OAuth flows to prevent
 * authorization code interception. The code_verifier stays
 * server-side; only the code_challenge is sent through the browser.
 *
 * This ensures auth codes are useless even if they leak into
 * agent context or logs.
 */

/**
 * Generate a cryptographically random code_verifier.
 * RFC 7636 §4.1: 43–128 characters from [A-Z, a-z, 0-9, -, ., _, ~]
 */
export function generateCodeVerifier(length = 64): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return base64urlEncode(bytes).slice(0, length);
}

/**
 * Generate code_challenge from a code_verifier using S256.
 * RFC 7636 §4.2: BASE64URL(SHA256(code_verifier))
 */
export async function generateCodeChallenge(
  verifier: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64urlEncode(new Uint8Array(digest));
}

/**
 * Generate a PKCE pair (verifier + challenge) in one call.
 */
export async function generatePkcePair(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}

// ============================================
// Helpers
// ============================================

/** Base64url encode without padding (RFC 4648 §5) */
function base64urlEncode(bytes: Uint8Array): string {
  const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
