/**
 * Auth Agent
 *
 * Built-in agent that provides OAuth2 client_credentials authentication.
 * Register it into any agent registry to enable auth.
 *
 * Features:
 * - Client credentials management (create, rotate, revoke)
 * - OAuth2 client_credentials token exchange
 * - JWT access tokens with scopes
 * - Pluggable AuthStore interface (in-memory default)
 * - Root key for admin operations
 *
 * @example
 * ```typescript
 * import { createAgentRegistry, createAgentServer, createAuthAgent } from '@slashfi/agents-sdk';
 *
 * const registry = createAgentRegistry();
 * registry.register(createAuthAgent({ rootKey: process.env.ROOT_KEY }));
 * registry.register(myAgent);
 *
 * const server = createAgentServer(registry, { port: 3000 });
 * await server.start();
 * ```
 */

import { defineAgent, defineTool } from "../define.js";
import { signJwt, generateSigningKey, exportSigningKey, type ExportedKeyPair } from "../jwt.js";
import type { AgentDefinition, ToolContext, ToolDefinition } from "../types.js";

// ============================================
// Auth Types
// ============================================

/** Registered client */
export interface AuthClient {
  clientId: string;
  tenantId?: string;
  clientSecretHash: string;
  name: string;
  scopes: string[];
  createdAt: number;
  /** If true, this client was created via self-registration */
  selfRegistered?: boolean;
}

/** Issued token metadata */
export interface AuthToken {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  issuedAt: number;
}

/** Resolved identity from a token or root key */
export interface AuthIdentity {
  clientId: string;
  name: string;
  scopes: string[];
  isRoot: boolean;
}

// ============================================
// Auth Store Interface
// ============================================

/**
 * Pluggable storage for auth state.
 * Implement this interface to use Postgres, Redis, SQLite, etc.
 */

/**
 * Tenant - organizational unit for multi-tenant isolation.
 */
export interface AuthTenant {
  id: string;
  name: string;
  createdAt: number;
}

export interface AuthStore {
  /** Create a tenant. */
  createTenant(name: string, externalRef?: { issuer: string; tenantId: string }): Promise<{ tenantId: string }>;

  /** Get tenant by ID. */
  getTenant(tenantId: string): Promise<AuthTenant | null>;

  /** List tenants. */
  listTenants(): Promise<AuthTenant[]>;

  /** Create a new client. Returns the raw (unhashed) secret. */
  createClient(
    name: string,
    scopes: string[],
    selfRegistered?: boolean,
    tenantId?: string,
  ): Promise<{ clientId: string; clientSecret: string }>;

  /** Validate client credentials. Returns client if valid, null otherwise. */
  validateClient(
    clientId: string,
    clientSecret: string,
  ): Promise<AuthClient | null>;

  /** Get client by ID. */
  getClient(clientId: string): Promise<AuthClient | null>;

  /** List all clients. */
  listClients(): Promise<AuthClient[]>;

  /** Revoke a client (delete). */
  revokeClient(clientId: string): Promise<boolean>;

  /** Rotate a client's secret. Returns new raw secret. */
  rotateSecret(clientId: string): Promise<{ clientSecret: string } | null>;

  /** Store a token. */
  storeToken(token: AuthToken): Promise<void>;

  /** Validate and retrieve a token. Returns null if invalid/expired. */
  validateToken(tokenString: string): Promise<AuthToken | null>;

  /** Revoke a specific token. */
  revokeToken(tokenString: string): Promise<boolean>;

  // --- Signing Keys ---

  /** Store a signing key pair (exported JWK format). */
  storeSigningKey?(key: ExportedKeyPair): Promise<void>;

  /** Get all signing keys (active + deprecated, not revoked). */
  getSigningKeys?(): Promise<ExportedKeyPair[]>;

  /** Get the current active signing key. */
  getActiveSigningKey?(): Promise<ExportedKeyPair | null>;

  /** Deprecate a signing key by kid. */
  deprecateSigningKey?(kid: string): Promise<boolean>;

  /** Revoke (remove) a signing key by kid. */
  revokeSigningKey?(kid: string): Promise<boolean>;

  // --- Trusted Issuers ---

  /** Add a trusted issuer URL. */
  addTrustedIssuer?(issuerUrl: string): Promise<void>;

  /** Remove a trusted issuer. */
  removeTrustedIssuer?(issuerUrl: string): Promise<boolean>;

  /** List all trusted issuer URLs. */
  listTrustedIssuers?(): Promise<string[]>;

  /** Register a user under a tenant. Returns a refresh token. */
  registerUser?(
    tenantId: string,
    userId: string,
    clientId: string,
  ): Promise<{ refreshToken: string }>;

  /** Validate a refresh token. Returns user info. */
  validateRefreshToken?(
    refreshToken: string,
  ): Promise<{ tenantId: string; userId: string; clientId: string } | null>;

  /** Rotate a refresh token. */
  rotateRefreshToken?(
    oldToken: string,
  ): Promise<{
    refreshToken: string;
    tenantId: string;
    userId: string;
    clientId: string;
  } | null>;
}

// ============================================
// In-Memory Auth Store
// ============================================

function generateId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = prefix;
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateSecret(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let secret = "sk_";
  for (let i = 0; i < 40; i++) {
    secret += chars[Math.floor(Math.random() * chars.length)];
  }
  return secret;
}

/** Simple hash for storing secrets (not for production - use bcrypt/argon2) */
async function hashSecret(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create an in-memory auth store.
 * Suitable for development and testing. Use a persistent store for production.
 */
export function createMemoryAuthStore(): AuthStore {
  const tenants = new Map<string, AuthTenant>();
  const clients = new Map<string, AuthClient>();
  const tokens = new Map<string, AuthToken>();
  const signingKeys = new Map<string, ExportedKeyPair>();
  const trustedIssuers = new Set<string>();

  return {
    async createTenant(name, _externalRef) {
      const id = `tenant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      tenants.set(id, { id, name, createdAt: Date.now() });
      return { tenantId: id };
    },

    async getTenant(tenantId) {
      return tenants.get(tenantId) ?? null;
    },

    async listTenants() {
      return Array.from(tenants.values());
    },

    async createClient(name, scopes, selfRegistered, tenantId) {
      const clientId = generateId("ag_");
      const clientSecret = generateSecret();
      const secretHash = await hashSecret(clientSecret);

      clients.set(clientId, {
        clientId,
        tenantId,
        clientSecretHash: secretHash,
        name,
        scopes,
        createdAt: Date.now(),
        selfRegistered,
      });

      return { clientId, clientSecret };
    },

    async validateClient(clientId, clientSecret) {
      const client = clients.get(clientId);
      if (!client) return null;
      const hash = await hashSecret(clientSecret);
      return hash === client.clientSecretHash ? client : null;
    },

    async getClient(clientId) {
      return clients.get(clientId) ?? null;
    },

    async listClients() {
      return Array.from(clients.values());
    },

    async revokeClient(clientId) {
      // Also revoke all tokens for this client
      for (const [tokenStr, token] of tokens) {
        if (token.clientId === clientId) {
          tokens.delete(tokenStr);
        }
      }
      return clients.delete(clientId);
    },

    async rotateSecret(clientId) {
      const client = clients.get(clientId);
      if (!client) return null;
      const clientSecret = generateSecret();
      client.clientSecretHash = await hashSecret(clientSecret);
      return {
        clientSecret: { $agent_type: "secret", value: clientSecret },
      } as any;
    },

    async storeToken(token) {
      tokens.set(token.token, token);
    },

    async validateToken(tokenString) {
      const token = tokens.get(tokenString);
      if (!token) return null;
      if (Date.now() > token.expiresAt) {
        tokens.delete(tokenString);
        return null;
      }
      return token;
    },

    async revokeToken(tokenString) {
      return tokens.delete(tokenString);
    },

    // --- Signing Keys ---

    async storeSigningKey(key) {
      signingKeys.set(key.kid, key);
    },

    async getSigningKeys() {
      return Array.from(signingKeys.values()).filter(k => k.status !== "revoked");
    },

    async getActiveSigningKey() {
      for (const key of signingKeys.values()) {
        if (key.status === "active") return key;
      }
      return null;
    },

    async deprecateSigningKey(kid) {
      const key = signingKeys.get(kid);
      if (!key) return false;
      key.status = "deprecated";
      return true;
    },

    async revokeSigningKey(kid) {
      return signingKeys.delete(kid);
    },

    // --- Trusted Issuers ---

    async addTrustedIssuer(issuerUrl) {
      trustedIssuers.add(issuerUrl);
    },

    async removeTrustedIssuer(issuerUrl) {
      return trustedIssuers.delete(issuerUrl);
    },

    async listTrustedIssuers() {
      return Array.from(trustedIssuers);
    },
  };
}

// ============================================
// Auth Agent Options
// ============================================

export interface CreateAuthAgentOptions {
  /** Root key for admin operations. Required. */
  rootKey: string;

  /** Allow self-registration via public `register` tool. Default: false */
  allowRegistration?: boolean;

  /** Max scopes that self-registered clients can request. Default: [] (no limit) */
  registrationScopes?: string[];

  /** Token TTL in seconds. Default: 3600 (1 hour) */
  tokenTtl?: number;

  /** Custom auth store. Default: in-memory */
  store?: AuthStore;

}

// ============================================
// Create Auth Agent
// ============================================

/**
 * Create the built-in `@auth` agent.
 *
 * Provides OAuth2 client_credentials authentication as agent tools.
 * The server auto-detects this agent and wires up token validation.
 */
export function createAuthAgent(
  options: CreateAuthAgentOptions,
): AgentDefinition & {
  __authStore: AuthStore;
  __rootKey: string;
  __tokenTtl: number;
} {
  const {
    rootKey,
    allowRegistration = false,
    registrationScopes,
    tokenTtl = 3600,
    store = createMemoryAuthStore(),
  } = options;

  // --- Public Tools ---

  const createTenantTool = defineTool({
    name: "create_tenant",
    description:
      "Create a new tenant (organizational unit). All clients and resources are scoped to a tenant.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Tenant name" },
        externalRef: {
          type: "object" as const,
          description: "Link to a tenant on a remote system (for cross-registry trust)",
          properties: {
            issuer: { type: "string" as const, description: "Issuer URL of the remote system" },
            tenantId: { type: "string" as const, description: "Tenant ID on the remote system" },
          },
          required: ["issuer", "tenantId"],
        },
      },
      required: ["name"],
    },
    execute: async (input: { name: string; externalRef?: { issuer: string; tenantId: string } }) => {
      const result = await store.createTenant(input.name, input.externalRef);
      return { tenantId: result.tenantId, name: input.name, externalRef: input.externalRef };
    
    },
  });

  const tokenTool = defineTool({
    name: "token",
    description:
      "Exchange client credentials for an access token (OAuth2 client_credentials grant)",
    visibility: "public",
    inputSchema: {
      type: "object",
      properties: {
        grantType: {
          type: "string",
          enum: ["client_credentials"],
          description: "Grant type. Must be 'client_credentials'.",
        },
        clientId: { type: "string", description: "Client ID" },
        clientSecret: { type: "string", description: "Client secret" },
      },
      required: ["grantType", "clientId", "clientSecret"],
    },
    execute: async (input: {
      grantType: string;
      clientId?: string;
      clientSecret?: string;
      userId?: string;
      refreshToken?: string;
    }) => {
      if (input.grantType === "refresh_token") {
        if (!input.refreshToken)
          throw new Error("refreshToken is required for refresh_token grant");
        if (!store.rotateRefreshToken)
          throw new Error("Refresh tokens not supported by this store");
        const result = await store.rotateRefreshToken(input.refreshToken);
        if (!result) throw new Error("Invalid or expired refresh token");
        const now = Math.floor(Date.now() / 1000);
        const jwt = await signJwt(
          {
            sub: result.clientId,
            name: result.userId,
            tenantId: result.tenantId,
            scopes: [],
            iat: now,
            exp: now + tokenTtl,
          },
          (await store.getClient(result.clientId))?.clientSecretHash ?? "",
        );
        return {
          accessToken: { $agent_type: "secret", value: jwt },
          refreshToken: { $agent_type: "secret", value: result.refreshToken },
          tokenType: "bearer",
          expiresIn: tokenTtl,
        } as any;
      }

      if (input.grantType !== "client_credentials") {
        throw new Error(
          "Unsupported grant type. Use 'client_credentials' or 'refresh_token'.",
        );
      }

      const client = await store.validateClient(
        input.clientId!,
        input.clientSecret!,
      );
      if (!client) {
        throw new Error("Invalid client credentials");
      }

      const now = Math.floor(Date.now() / 1000);
      const jwt = await signJwt(
        {
          sub: client.clientId,
          name: client.name,
          tenantId: client.tenantId,
          scopes: client.scopes,
          iat: now,
          exp: now + tokenTtl,
        },
        client.clientSecretHash,
      );

      return {
        accessToken: { $agent_type: "secret", value: jwt },
        tokenType: "bearer",
        expiresIn: tokenTtl,
        scopes: client.scopes,
      };
    },
  });

  const whoamiTool = defineTool({
    name: "whoami",
    description: "Introspect the current authentication context",
    visibility: "public",
    inputSchema: { type: "object", properties: {} },
    execute: async (_input: unknown, ctx: ToolContext) => {
      return {
        callerId: ctx.callerId,
        callerType: ctx.callerType,
        scopes: (ctx as ToolContext & { scopes?: string[] }).scopes ?? [],
        isRoot: ctx.callerId === "root",
      };
    },
  });

  // --- Optional Public Tool ---

  const registerTool = defineTool({
    name: "register",
    description: "Register a new agent client (self-service)",
    visibility: "public",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for this client" },
        scopes: {
          type: "array",
          items: { type: "string" },
          description: "Requested scopes",
        },
      },
      required: ["name"],
    },
    execute: async (input: {
      name: string;
      tenantId: string;
      scopes?: string[];
    }) => {
      let scopes = input.scopes ?? [];

      // If registration scopes are restricted, filter
      if (registrationScopes && registrationScopes.length > 0) {
        scopes = scopes.filter((s) => registrationScopes.includes(s));
      }

      const { clientId, clientSecret } = await store.createClient(
        input.name,
        scopes,
        true,
        input.tenantId,
      );

      return {
        clientId,
        clientSecret: { $agent_type: "secret", value: clientSecret },
        scopes,
      } as any;
    },
  });

  // --- Private Tools (root key only) ---

  const createClientTool = defineTool({
    name: "create_client",
    description: "Create a new client with specific scopes (admin only)",
    visibility: "private",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Client name" },
        scopes: {
          type: "array",
          items: { type: "string" },
          description: "Scopes to grant",
        },
      },
      required: ["name", "scopes"],
    },
    execute: async (input: { name: string; scopes: string[] }) => {
      const { clientId, clientSecret } = await store.createClient(
        input.name,
        input.scopes,
      );
      return { clientId, clientSecret, scopes: input.scopes };
    },
  });

  const listClientsTool = defineTool({
    name: "list_clients",
    description: "List all registered clients (admin only)",
    visibility: "private",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const clients = await store.listClients();
      return {
        clients: clients.map((c) => ({
          clientId: c.clientId,
          name: c.name,
          scopes: c.scopes,
          createdAt: c.createdAt,
          selfRegistered: c.selfRegistered ?? false,
        })),
      };
    },
  });

  const revokeClientTool = defineTool({
    name: "revoke_client",
    description: "Revoke a client and all its tokens (admin only)",
    visibility: "private",
    inputSchema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "Client ID to revoke" },
      },
      required: ["clientId"],
    },
    execute: async (input: { clientId: string }) => {
      const revoked = await store.revokeClient(input.clientId);
      return { revoked };
    },
  });

  const rotateSecretTool = defineTool({
    name: "rotate_secret",
    description: "Rotate a client's secret (admin only)",
    visibility: "private",
    inputSchema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "Client ID to rotate" },
      },
      required: ["clientId"],
    },
    execute: async (input: { clientId: string }) => {
      const result = await store.rotateSecret(input.clientId);
      if (!result) throw new Error(`Client not found: ${input.clientId}`);
      return { clientId: input.clientId, clientSecret: result.clientSecret };
    },
  });

  // --- Assemble tools ---

  // --- Key Management Tools ---

  const rotateKeysTool = defineTool({
    name: "rotate_keys",
    description:
      "Generate a new ES256 signing key and deprecate the current active key. The old key remains valid for verification during the overlap period.",
    visibility: "private" as const,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    execute: async () => {
      if (!store.storeSigningKey || !store.getActiveSigningKey || !store.deprecateSigningKey)
        throw new Error("Store does not support signing key management");

      // Deprecate current active key
      const current = await store.getActiveSigningKey();
      if (current) {
        await store.deprecateSigningKey(current.kid);
      }

      // Generate and store new key
      const newKey = await generateSigningKey();
      const exported = await exportSigningKey(newKey);
      await store.storeSigningKey(exported);

      return {
        newKid: newKey.kid,
        deprecatedKid: current?.kid ?? null,
        message: "New signing key generated. Old key deprecated but still valid for verification.",
      };
    },
  });


  const apiKeyTool = defineTool({
    name: "api_key",
    description: "Create or list API keys for MCP access.",
    visibility: "authenticated" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["create", "list"], description: "Action" },
        name: { type: "string", description: "Key name" },
        scopes: { type: "array", items: { type: "string" }, description: "Scopes" },
      },
      required: ["action"],
    },
    execute: async (input: { action: string; name?: string; scopes?: string[] }) => {

      if (input.action === "create") {
        const result = await store.createClient(
          input.name ?? "api-key",
          input.scopes ?? ["*"],
          false,
        );
        return { key: result.clientSecret, clientId: result.clientId };
      }
      if (input.action === "list") {
        const clients = await store.listClients();
        return { keys: clients.map(c => ({ id: c.clientId, name: c.name, scopes: c.scopes })) };
      }
      return { error: "Unknown action" };
    },
  });

  const trustIssuerTool = defineTool({
    name: "trust_issuer",
    description:
      "Add or remove a trusted issuer URL. JWTs from trusted issuers are verified against their JWKS endpoint.",
    visibility: "private" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["add", "remove", "list"],
          description: "Action to perform",
        },
        issuerUrl: {
          type: "string" as const,
          description: "Issuer URL (required for add/remove)",
        },
      },
      required: ["action"],
    },
    execute: async (
      input: { action: "add" | "remove" | "list"; issuerUrl?: string },
    ) => {
      if (!store.addTrustedIssuer || !store.removeTrustedIssuer || !store.listTrustedIssuers)
        throw new Error("Store does not support trusted issuer management");

      switch (input.action) {
        case "add": {
          if (!input.issuerUrl) throw new Error("issuerUrl is required");
          await store.addTrustedIssuer(input.issuerUrl);
          return { success: true, message: `Added trusted issuer: ${input.issuerUrl}` };
        }
        case "remove": {
          if (!input.issuerUrl) throw new Error("issuerUrl is required");
          const removed = await store.removeTrustedIssuer(input.issuerUrl);
          return { success: removed, message: removed ? "Removed" : "Not found" };
        }
        case "list": {
          const issuers = await store.listTrustedIssuers();
          return { issuers };
        }
      }
    },
  });


  const exchangeTokenTool = defineTool({
    name: "exchange_token",
    description:
      "Exchange a foreign JWT for a local identity. Verifies the JWT via JWKS, " +
      "resolves the tenant and user to local IDs. If the user is not yet linked, " +
      "returns needsAuth=true with a connect URL for OAuth identity linking.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        token: {
          type: "string" as const,
          description: "JWT signed by a trusted issuer",
        },
        connectBaseUrl: {
          type: "string" as const,
          description: "Base URL for the OAuth connect flow (returned in needsAuth response)",
        },
      },
      required: ["token"],
    },
    execute: async (
      _input: { token: string; connectBaseUrl?: string },
    ) => {
      // This tool is a stub — the actual implementation needs:
      // 1. JWT verification (via verifyJwtFromIssuer)
      // 2. Tenant resolution (via tenant_identity table)
      // 3. User resolution (via user_identity table)
      // These depend on the store having identity lookup methods.
      //
      // For now, return the structure so the flow can be wired.
      // The atlas-environments CockroachDB implementation overrides this.
      return {
        error: "exchange_token requires a store with identity resolution support",
        hint: "Override this tool in your environment implementation",
      };
    },
  });

  const tools = [
    createTenantTool,
    tokenTool,
    whoamiTool,
    ...(allowRegistration ? [registerTool] : []),
    createClientTool,
    listClientsTool,
    revokeClientTool,
    rotateSecretTool,
    rotateKeysTool,
    trustIssuerTool,
    apiKeyTool,
    exchangeTokenTool,
  ];

  const agent = defineAgent({
    path: "@auth",
    entrypoint:
      "Authentication agent. Provides OAuth2 client_credentials authentication for the agent network.",
    config: {
      name: "Auth",
      visibility: "public",
      description: "Built-in authentication agent",
      supportedActions: ["execute_tool", "describe_tools", "load"],
    },
    tools: tools as ToolDefinition<ToolContext>[],
    visibility: "public",
  });

  // Attach store and config for server integration
  return Object.assign(agent, {
    __authStore: store,
    __rootKey: rootKey,
    __tokenTtl: tokenTtl,
  });
}
