/**
 * Users Agent (@users)
 *
 * Built-in agent for user and user identity management.
 * Provides user CRUD and identity linking (OAuth providers, SSO, etc.).
 *
 * A User is a human entity. A UserIdentity links a user to an external
 * identity provider (e.g. Google, Slack, GitHub) — one user can have
 * many identities.
 *
 * @example
 * ```typescript
 * import { createAgentRegistry, createUsersAgent } from '@slashfi/agents-sdk';
 *
 * const registry = createAgentRegistry();
 * registry.register(createUsersAgent({
 *   store: myUserStore,
 * }));
 * ```
 */

import { defineAgent, defineTool } from "../define.js";
import type { AgentDefinition, ToolContext, ToolDefinition } from "../types.js";

// ============================================
// User Types
// ============================================

export interface User {
  id: string;
  tenantId: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * A link between a User and an external identity provider.
 * One user can have many identities (e.g. Google + Slack + GitHub).
 */
export interface UserIdentity {
  id: string;
  userId: string;
  provider: string;
  /** External provider's user ID */
  providerUserId: string;
  /** Display info from the provider */
  email?: string;
  name?: string;
  avatarUrl?: string;
  /** OAuth tokens (encrypted at rest in the store) */
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
  connectedAt: number;
  updatedAt: number;
}

// ============================================
// User Store Interface
// ============================================

/**
 * Pluggable storage backend for users and identities.
 */
export interface UserStore {
  // Users
  createUser(user: Omit<User, "createdAt" | "updatedAt">): Promise<User>;
  getUser(userId: string): Promise<User | null>;
  getUserByEmail(tenantId: string, email: string): Promise<User | null>;
  listUsers(tenantId: string): Promise<User[]>;
  updateUser(
    userId: string,
    updates: Partial<Pick<User, "email" | "name" | "avatarUrl" | "metadata">>,
  ): Promise<User | null>;
  deleteUser(userId: string): Promise<boolean>;

  // Identities
  createIdentity(
    identity: Omit<UserIdentity, "connectedAt" | "updatedAt">,
  ): Promise<UserIdentity>;
  getIdentity(identityId: string): Promise<UserIdentity | null>;
  getIdentityByProvider(
    userId: string,
    provider: string,
  ): Promise<UserIdentity | null>;
  findIdentityByProviderUserId(
    provider: string,
    providerUserId: string,
  ): Promise<UserIdentity | null>;
  listIdentities(userId: string): Promise<UserIdentity[]>;
  updateIdentity(
    identityId: string,
    updates: Partial<
      Pick<
        UserIdentity,
        | "accessToken"
        | "refreshToken"
        | "expiresAt"
        | "email"
        | "name"
        | "avatarUrl"
        | "metadata"
      >
    >,
  ): Promise<UserIdentity | null>;
  deleteIdentity(identityId: string): Promise<boolean>;
}

// ============================================
// In-Memory User Store
// ============================================

function generateId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = prefix;
  for (let i = 0; i < 20; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function createInMemoryUserStore(): UserStore {
  const users = new Map<string, User>();
  const identities = new Map<string, UserIdentity>();

  return {
    async createUser(input) {
      const now = Date.now();
      const user: User = { ...input, createdAt: now, updatedAt: now };
      users.set(user.id, user);
      return user;
    },

    async getUser(userId) {
      return users.get(userId) ?? null;
    },

    async getUserByEmail(tenantId, email) {
      for (const u of users.values()) {
        if (u.tenantId === tenantId && u.email === email) return u;
      }
      return null;
    },

    async listUsers(tenantId) {
      return Array.from(users.values()).filter((u) => u.tenantId === tenantId);
    },

    async updateUser(userId, updates) {
      const user = users.get(userId);
      if (!user) return null;
      const updated = { ...user, ...updates, updatedAt: Date.now() };
      users.set(userId, updated);
      return updated;
    },

    async deleteUser(userId) {
      // Delete identities too
      for (const [id, identity] of identities) {
        if (identity.userId === userId) identities.delete(id);
      }
      return users.delete(userId);
    },

    async createIdentity(input) {
      const now = Date.now();
      const identity: UserIdentity = {
        ...input,
        connectedAt: now,
        updatedAt: now,
      };
      identities.set(identity.id, identity);
      return identity;
    },

    async getIdentity(identityId) {
      return identities.get(identityId) ?? null;
    },

    async getIdentityByProvider(userId, provider) {
      for (const identity of identities.values()) {
        if (identity.userId === userId && identity.provider === provider)
          return identity;
      }
      return null;
    },

    async findIdentityByProviderUserId(provider, providerUserId) {
      for (const identity of identities.values()) {
        if (
          identity.provider === provider &&
          identity.providerUserId === providerUserId
        )
          return identity;
      }
      return null;
    },

    async listIdentities(userId) {
      return Array.from(identities.values()).filter((i) => i.userId === userId);
    },

    async updateIdentity(identityId, updates) {
      const identity = identities.get(identityId);
      if (!identity) return null;
      const updated = { ...identity, ...updates, updatedAt: Date.now() };
      identities.set(identityId, updated);
      return updated;
    },

    async deleteIdentity(identityId) {
      return identities.delete(identityId);
    },
  };
}

// ============================================
// Create Users Agent
// ============================================

export interface UsersAgentOptions {
  /** User store backend */
  store: UserStore;
}

export function createUsersAgent(options: UsersAgentOptions): AgentDefinition {
  const { store } = options;

  // ---- create_user ----
  const createUserTool = defineTool({
    name: "create_user",
    description: "Create a new user.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "User ID (optional, auto-generated if omitted)",
        },
        tenantId: { type: "string", description: "Tenant ID" },
        email: { type: "string", description: "Email address" },
        name: { type: "string", description: "Display name" },
        avatarUrl: { type: "string", description: "Avatar URL" },
        metadata: { type: "object", description: "Additional metadata" },
        externalRef: {
          type: "object",
          description: "Link to a user on a remote system. Creates identity automatically.",
          properties: {
            issuer: { type: "string", description: "Issuer URL of the remote system" },
            userId: { type: "string", description: "User ID on the remote system" },
          },
        },
      },
      required: ["tenantId"],
    },
    execute: async (input: any, __ctx: ToolContext) => {
      // If externalRef provided, check if identity already exists
      if (input.externalRef) {
        const existing = await store.findIdentityByProviderUserId(
          input.externalRef.issuer,
          input.externalRef.userId,
        );
        if (existing) {
          const user = await store.getUser(existing.userId);
          return { success: true, user, identity: existing, alreadyLinked: true };
        }
      }

      const user = await store.createUser({
        id: input.id ?? generateId("user_"),
        tenantId: input.tenantId,
        email: input.email,
        name: input.name,
        avatarUrl: input.avatarUrl,
        metadata: input.metadata,
      });

      // Auto-create identity link if externalRef provided
      let identity: UserIdentity | undefined;
      if (input.externalRef) {
        identity = await store.createIdentity({
          id: generateId("uid_"),
          userId: user.id,
          provider: input.externalRef.issuer,
          providerUserId: input.externalRef.userId,
          email: input.email,
          name: input.name,
        });
      }

      return { success: true, user, identity };
    },
  });

  // ---- get_user ----
  const getUserTool = defineTool({
    name: "get_user",
    description: "Get a user by ID.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        userId: { type: "string", description: "User ID" },
      },
      required: ["userId"],
    },
    execute: async (input: { userId: string }, __ctx: ToolContext) => {
      const user = await store.getUser(input.userId);
      if (!user) return { error: `User '${input.userId}' not found` };
      return { user };
    },
  });

  // ---- list_users ----
  const listUsersTool = defineTool({
    name: "list_users",
    description: "List users in a tenant.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        tenantId: { type: "string", description: "Tenant ID" },
      },
      required: ["tenantId"],
    },
    execute: async (input: { tenantId: string }, __ctx: ToolContext) => {
      const users = await store.listUsers(input.tenantId);
      return { users };
    },
  });

  // ---- update_user ----
  const updateUserTool = defineTool({
    name: "update_user",
    description: "Update a user's profile.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        userId: { type: "string", description: "User ID" },
        email: { type: "string", description: "New email" },
        name: { type: "string", description: "New name" },
        avatarUrl: { type: "string", description: "New avatar URL" },
        metadata: { type: "object", description: "New metadata (merged)" },
      },
      required: ["userId"],
    },
    execute: async (input: any, __ctx: ToolContext) => {
      const { userId, ...updates } = input;
      const user = await store.updateUser(userId, updates);
      if (!user) return { error: `User '${userId}' not found` };
      return { success: true, user };
    },
  });

  // ---- link_identity ----
  const linkIdentityTool = defineTool({
    name: "link_identity",
    description:
      "Link an external identity (OAuth provider) to a user. " +
      "Creates a UserIdentity record associating the user with a provider account.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        userId: { type: "string", description: "User ID to link to" },
        provider: {
          type: "string",
          description: "Provider name (e.g. 'google', 'slack', 'github')",
        },
        providerUserId: {
          type: "string",
          description: "The user's ID in the external provider",
        },
        email: { type: "string", description: "Email from the provider" },
        name: { type: "string", description: "Name from the provider" },
        avatarUrl: {
          type: "string",
          description: "Avatar URL from the provider",
        },
        accessToken: { type: "string", description: "OAuth access token" },
        refreshToken: { type: "string", description: "OAuth refresh token" },
        expiresAt: {
          type: "number",
          description: "Token expiry timestamp (ms)",
        },
        scopes: {
          type: "array",
          items: { type: "string" },
          description: "Granted scopes",
        },
        metadata: {
          type: "object",
          description: "Additional provider-specific data",
        },
      },
      required: ["userId", "provider", "providerUserId"],
    },
    execute: async (input: any, __ctx: ToolContext) => {
      // Check if identity already exists
      const existing = await store.getIdentityByProvider(
        input.userId,
        input.provider,
      );
      if (existing) {
        // Update existing
        const updated = await store.updateIdentity(existing.id, {
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          expiresAt: input.expiresAt,
          email: input.email,
          name: input.name,
          avatarUrl: input.avatarUrl,
          metadata: input.metadata,
        });
        return { success: true, identity: updated, updated: true };
      }

      const identity = await store.createIdentity({
        id: generateId("ident_"),
        userId: input.userId,
        provider: input.provider,
        providerUserId: input.providerUserId,
        email: input.email,
        name: input.name,
        avatarUrl: input.avatarUrl,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt,
        tokenType: input.tokenType,
        scopes: input.scopes,
        metadata: input.metadata,
      });
      return { success: true, identity, created: true };
    },
  });

  // ---- list_identities ----
  const listIdentitiesTool = defineTool({
    name: "list_identities",
    description: "List all linked identities for a user.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        userId: { type: "string", description: "User ID" },
      },
      required: ["userId"],
    },
    execute: async (input: { userId: string }, __ctx: ToolContext) => {
      const identities = await store.listIdentities(input.userId);
      return {
        identities: identities.map((i) => ({
          id: i.id,
          provider: i.provider,
          providerUserId: i.providerUserId,
          email: i.email,
          name: i.name,
          connectedAt: i.connectedAt,
          hasAccessToken: !!i.accessToken,
          expiresAt: i.expiresAt,
        })),
      };
    },
  });

  // ---- unlink_identity ----
  const unlinkIdentityTool = defineTool({
    name: "unlink_identity",
    description: "Remove a linked identity from a user.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        identityId: { type: "string", description: "Identity ID to unlink" },
      },
      required: ["identityId"],
    },
    execute: async (input: { identityId: string }, __ctx: ToolContext) => {
      const deleted = await store.deleteIdentity(input.identityId);
      return { success: deleted };
    },
  });

  // ---- resolve_identity ----
  const resolveIdentityTool = defineTool({
    name: "resolve_identity",
    description:
      "Find a user by their external provider identity. " +
      "Useful for login flows — given a provider + providerUserId, find the linked user.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        provider: {
          type: "string",
          description: "Provider name (e.g. 'google')",
        },
        providerUserId: {
          type: "string",
          description: "External user ID from the provider",
        },
      },
      required: ["provider", "providerUserId"],
    },
    execute: async (
      input: { provider: string; providerUserId: string },
      __ctx: ToolContext,
    ) => {
      const identity = await store.findIdentityByProviderUserId(
        input.provider,
        input.providerUserId,
      );
      if (!identity) return { found: false };

      const user = await store.getUser(identity.userId);
      return {
        found: true,
        user: user
          ? {
              id: user.id,
              email: user.email,
              name: user.name,
              tenantId: user.tenantId,
            }
          : null,
        identity: {
          id: identity.id,
          provider: identity.provider,
          providerUserId: identity.providerUserId,
          email: identity.email,
        },
      };
    },
  });

  return defineAgent({
    path: "@users",
    entrypoint:
      "You are the users agent. You manage user accounts and their linked external identities " +
      "(OAuth providers like Google, Slack, GitHub, etc.).",
    config: {
      name: "Users",
      description: "User and identity management",
      supportedActions: ["execute_tool", "describe_tools", "load"],
    },
    visibility: "public",
    tools: [
      createUserTool,
      getUserTool,
      listUsersTool,
      updateUserTool,
      linkIdentityTool,
      listIdentitiesTool,
      unlinkIdentityTool,
      resolveIdentityTool,
    ] as ToolDefinition[],
  });
}
