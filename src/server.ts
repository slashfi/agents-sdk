/**
 * Re-export from modular server.
 * @deprecated Import from "./server/index.js" directly.
 */
export {
  createAgentServer,
  detectAuth,
  resolveAuth,
  canSeeAgent,
  hasAdminScope,
} from "./server/index.js";

export type {
  AgentServer,
  AgentServerOptions,
  AuthConfig,
  OAuthIdentityProvider,
  ResolvedAuth,
  TrustedIssuer,
} from "./server/index.js";
