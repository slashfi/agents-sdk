/**
 * Server module barrel exports.
 */

export { createAgentServer } from "./server.js";
export { detectAuth, resolveAuth, canSeeAgent, hasAdminScope } from "./auth.js";
export type {
  AgentServer,
  AgentServerOptions,
  AuthConfig,
  OAuthIdentityProvider,
  ResolvedAuth,
  TrustedIssuer,
} from "./types.js";
