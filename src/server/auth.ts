/**
 * Auth detection, resolution, and visibility helpers.
 */

import type { AuthStore } from "../agent-definitions/auth.js";
import type { SigningKey } from "../jwt.js";
import { verifyJwt, verifyJwtFromIssuer, verifyJwtLocal } from "../jwt.js";
import type { AgentRegistry } from "../registry.js";
import type { AgentDefinition, Visibility } from "../types.js";
import { hasAdminScope } from "./types.js";
import type { AuthConfig, ResolvedAuth, TrustedIssuer } from "./types.js";

export { hasAdminScope } from "./types.js";

export function detectAuth(registry: AgentRegistry): AuthConfig {
  const authAgent = registry.get("@auth") as
    | (AgentDefinition & {
        __authStore?: AuthStore;
        __tokenTtl?: number;
      })
    | undefined;

  if (!authAgent?.__authStore) return {};

  return {
    store: authAgent.__authStore,
    tokenTtl: authAgent.__tokenTtl ?? 3600,
  };
}

export async function resolveAuth(
  req: Request,
  authConfig: AuthConfig,
  jwksOptions?: {
    signingKeys?: SigningKey[];
    trustedIssuers?: TrustedIssuer[];
  },
): Promise<ResolvedAuth | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const [scheme, credential] = authHeader.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !credential) return null;

  // Try ES256 verification against own signing keys
  const parts = credential.split(".");
  if (parts.length === 3 && jwksOptions?.signingKeys?.length) {
    for (const key of jwksOptions.signingKeys) {
      try {
        const verified = await verifyJwtLocal(credential, key.publicKey);
        if (verified) {
          return {
            callerId: verified.sub ?? verified.name ?? "unknown",
            callerType: "agent",
            scopes: verified.scopes ?? ["*"],
            claims: verified as unknown as Record<string, unknown>,
          };
        }
      } catch {}
    }
  }

  // Try trusted issuers (remote JWKS verification)
  // Trusted issuer verification: decode iss claim, look up in config, verify JWKS
  if (parts.length === 3 && jwksOptions?.trustedIssuers?.length) {
    try {
      // Peek at unverified payload to read iss
      const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const unverified = JSON.parse(atob(payloadB64)) as { iss?: string };
      if (unverified.iss) {
        const issuerConfig = jwksOptions.trustedIssuers.find(
          (i) => i.issuer === unverified.iss,
        );
        if (issuerConfig) {
          const verified = await verifyJwtFromIssuer(
            credential,
            issuerConfig.issuer,
          );
          if (verified) {
            const scopes = issuerConfig.scopes;
            const isSystem =
              scopes.includes("*") || scopes.includes("agents:admin");
            return {
              callerId: verified.sub ?? verified.name ?? "unknown",
              callerType: isSystem ? "system" : "agent",
              scopes,
              claims: verified as unknown as Record<string, unknown>,
            };
          }
        }
      }
    } catch {
      // Failed to decode/verify, fall through
    }
  }

  // Try HMAC JWT verification (legacy, stateless)
  if (parts.length === 3) {
    try {
      const payloadB64 = parts[1];
      const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(padded)) as {
        sub?: string;
        name?: string;
        scopes?: string[];
        exp?: number;
      };

      if (payload.sub && authConfig.store) {
        const client = await authConfig.store.getClient(payload.sub);
        if (client) {
          const verified = await verifyJwt(credential, client.clientSecretHash);
          if (verified) {
            return {
              callerId: verified.name || client.name,
              callerType: "agent",
              scopes: verified.scopes,
              claims: verified as unknown as Record<string, unknown>,
            };
          }
        }
      }
    } catch {
      // Not a valid JWT, fall through to legacy token validation
    }
  }

  // Legacy: opaque token validation (backwards compat)
  if (!authConfig.store) return null;
  const token = await authConfig.store.validateToken(credential);
  if (!token) return null;

  const client = await authConfig.store.getClient(token.clientId);
  return {
    callerId: client?.name ?? token.clientId,
    callerType: "agent",
    scopes: token.scopes,
    claims: {},
  };
}

export function canSeeAgent(
  agent: AgentDefinition,
  auth: ResolvedAuth | null,
): boolean {
  const visibility = ((agent as any).visibility ??
    agent.config?.visibility ??
    "internal") as Visibility;
  if (hasAdminScope(auth)) return true;
  if (visibility === "public") return true;
  if (visibility === "internal" && auth) return true;
  return false;
}

/**
 * Resolve an agent by path, handling @ prefix normalization.
 * Tries the path as-is first, then with @ prefix.
 */
export function resolveAgent(
  registry: AgentRegistry,
  path: string,
): AgentDefinition | undefined {
  const normalized = path.replace(/^@/, "");
  return registry.get(normalized) ?? registry.get(`@${normalized}`);
}

/**
 * Filter tools visible on a public agent endpoint.
 * For /agents/ routes, tools inherit the agent's visibility:
 * - If agent is public, tools without explicit visibility are shown
 * - Tool-level visibility still overrides (e.g. visibility: "private" hides it)
 */
export function getVisibleTools(
  agent: AgentDefinition,
  auth: ResolvedAuth | null,
): typeof agent.tools {
  const agentVisibility = ((agent as any).visibility ??
    agent.config?.visibility ??
    "internal") as Visibility;
  return agent.tools.filter((t) => {
    const tv = t.visibility;
    if (hasAdminScope(auth)) return true;
    // Tool has explicit visibility — respect it
    if (tv === "public") return true;
    if (tv === "private") return hasAdminScope(auth) ?? false;
    if (tv === "internal" && auth) return true;
    // No explicit tool visibility — inherit from agent
    if (!tv && agentVisibility === "public") return true;
    if (!tv && agentVisibility === "internal" && auth) return true;
    return false;
  });
}
