/**
 * Auth Governance
 *
 * Single source of truth for visibility and access control decisions.
 * Used by the server, middleware, and any custom implementations.
 */

import type { Visibility, AgentDefinition } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedAuth {
  issuer?: string;
  callerId: string;
  callerType: "agent" | "user" | "system";
  scopes: string[];
  /** All JWT claims from the verified token (passthrough) */
  claims: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Governance Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if the auth context has admin scope.
 */
export function hasAdminScope(auth: ResolvedAuth | null): boolean {
  if (!auth) return false;
  return auth.scopes.includes("*") || auth.scopes.includes("admin");
}

/**
 * Check if an agent is visible to the given auth context.
 */
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
 * Check if a tool is visible to the given auth context.
 *
 * When agentVisibility is provided, tools without explicit visibility
 * inherit from their parent agent.
 */
export function canSeeTool(
  tool: { visibility?: Visibility },
  auth: ResolvedAuth | null,
  agentVisibility?: Visibility,
): boolean {
  const tv = tool.visibility;
  if (hasAdminScope(auth)) return true;
  // Tool has explicit visibility — respect it
  if (tv === "public") return true;
  if (tv === "private") return false;
  if (
    tv === "authenticated" &&
    auth?.callerId &&
    auth.callerId !== "anonymous"
  )
    return true;
  if (tv === "internal" && auth) return true;
  // No explicit tool visibility — inherit from agent or default to internal
  if (!tv) {
    const inherited = agentVisibility ?? "internal";
    if (inherited === "public") return true;
    if (inherited === "internal" && auth) return true;
  }
  return false;
}

/**
 * Get visible tools for an agent, respecting visibility inheritance.
 */
export function getVisibleTools(
  agent: AgentDefinition,
  auth: ResolvedAuth | null,
): typeof agent.tools {
  const agentVisibility = ((agent as any).visibility ??
    agent.config?.visibility ??
    "internal") as Visibility;
  return agent.tools.filter((t) => canSeeTool(t, auth, agentVisibility));
}
