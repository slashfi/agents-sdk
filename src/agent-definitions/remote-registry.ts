/**
 * Remote Registry Agent
 *
 * Integration agent for connecting to remote agent registries.
 * Uses the IntegrationMethods pattern so @integrations can discover
 * and interact with it uniformly via setup/connect/list/get/update.
 *
 * Each remote registry connection stores:
 * - url: the registry's base URL
 * - tenantId: the tenant created on the remote registry
 * - clientId + clientSecret: credentials for authentication
 *
 * @example
 * ```typescript
 * import { createRemoteRegistryAgent, createAgentRegistry } from '@slashfi/agents-sdk';
 *
 * const registry = createAgentRegistry();
 * registry.register(createRemoteRegistryAgent({ secretStore }));
 *
 * // Then via @integrations:
 * // setup_integration({ provider: 'remote-registry', params: { url: 'https://registry.slash.com', name: 'slash' } })
 * // connect_integration({ provider: 'remote-registry', params: { registryId: 'slash', userId: 'user_123' } })
 * ```
 */

import { defineAgent, defineTool } from "../define.js";
import type {
  AgentDefinition,
  IntegrationMethodContext,
  IntegrationMethodResult,
  ToolContext,
} from "../types.js";
import type { SecretStore } from "./secrets.js";

// ============================================
// Types
// ============================================

export interface RemoteRegistryAgentOptions {
  /** Secret store for persisting registry credentials */
  secretStore: SecretStore;
}

/** Stored connection to a remote registry */
interface RegistryConnection {
  /** Registry identifier (user-chosen name) */
  id: string;
  /** Display name */
  name: string;
  /** Registry base URL */
  url: string;
  /** Tenant ID on the remote registry */
  remoteTenantId: string;
  /** Client ID for authentication */
  clientId: string;
  /** When the connection was created */
  createdAt: number;
}


// ============================================
// Helpers
// ============================================


/**
 * Make an MCP JSON-RPC call to a remote registry.
 */
async function mcpCall(
  url: string,
  token: string,
  request: {
    action: string;
    path: string;
    tool: string;
    params?: Record<string, unknown>;
  },
): Promise<any> {
  const res = await globalThis.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "call_agent",
        arguments: {
          request: {
            action: request.action,
            path: request.path,
            tool: request.tool,
            params: request.params ?? {},
          },
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Registry call failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as any;
  if (json.error) {
    throw new Error(
      `Registry RPC error: ${json.error.message ?? JSON.stringify(json.error)}`,
    );
  }

  // Parse the tool result from MCP response
  const text = json?.result?.content?.[0]?.text;
  if (!text) return json?.result;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Get an access token from a remote registry via /oauth/token.
 */
async function getRegistryToken(
  url: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const tokenUrl = url.replace(/\/$/, "") + "/oauth/token";
  const res = await globalThis.fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

// ============================================
// Create Remote Registry Agent
// ============================================

export function createRemoteRegistryAgent(
  options: RemoteRegistryAgentOptions,
): AgentDefinition {
  const { secretStore } = options;

  // We store all registry connections as a single JSON blob per owner.
  // The secret ID is stored via associate/resolveByEntity for lookup.
  const ENTITY_TYPE = "remote-registry-connections";

  /**
   * Store a registry connection (metadata + credentials).
   */
  async function storeConnection(
    ownerId: string,
    conn: RegistryConnection,
    clientSecret: string,
  ): Promise<void> {
    // Load existing connections, update, and store back
    const all = await loadAllConnections(ownerId);
    all[conn.id] = { ...conn, clientSecret };
    const value = JSON.stringify(all);

    // Store the blob
    const scope = { tenantId: ownerId };
    const secretId = await secretStore.store(value, ownerId);

    // Link it so we can find it later
    if (secretStore.associate) {
      await secretStore.associate(secretId, ENTITY_TYPE, ownerId, scope);
    }
  }

  /**
   * Load all connections from the stored blob.
   */
  async function loadAllConnections(
    ownerId: string,
  ): Promise<Record<string, RegistryConnection & { clientSecret: string }>> {
    // Try resolveByEntity first (v0.7.0+)
    if (secretStore.resolveByEntity) {
      const scope = { tenantId: ownerId };
      const secretIds = await secretStore.resolveByEntity(ENTITY_TYPE, ownerId, scope);
      if (secretIds && secretIds.length > 0) {
        // Resolve the latest stored blob
        const latestId = secretIds[secretIds.length - 1];
        const raw = await secretStore.resolve(latestId, ownerId);
        if (raw) {
          try {
            return JSON.parse(raw);
          } catch {
            return {};
          }
        }
      }
    }
    return {};
  }

  /**
   * Load a registry connection.
   */
  async function loadConnection(
    ownerId: string,
    registryId: string,
  ): Promise<{ conn: RegistryConnection; clientSecret: string } | null> {
    const all = await loadAllConnections(ownerId);
    const entry = all[registryId];
    if (!entry) return null;
    const { clientSecret, ...conn } = entry;
    return { conn, clientSecret };
  }

  /**
   * List all registry connections for an owner.
   */
  async function listConnectionsList(
    ownerId: string,
  ): Promise<RegistryConnection[]> {
    const all = await loadAllConnections(ownerId);
    return Object.values(all).map(({ clientSecret: _, ...conn }) => conn);
  }

  /**
   * Get an authenticated token for a registry connection.
   */
  async function getAuthenticatedToken(
    ownerId: string,
    registryId: string,
  ): Promise<{ token: string; conn: RegistryConnection }> {
    const data = await loadConnection(ownerId, registryId);
    if (!data) {
      throw new Error(
        `No registry connection '${registryId}'. Use setup_integration first.`,
      );
    }
    const token = await getRegistryToken(
      data.conn.url,
      data.conn.clientId,
      data.clientSecret,
    );
    return { token, conn: data.conn };
  }

  // ---- Tools ----

  const callRemoteTool = defineTool({
    name: "call_remote",
    description:
      "Make an authenticated MCP call to a remote agent registry. " +
      "Proxies the request with the stored tenant credentials.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        registryId: {
          type: "string",
          description: "Registry connection ID",
        },
        agentPath: {
          type: "string",
          description: "Agent path on the remote registry (e.g. '@integrations')",
        },
        action: {
          type: "string",
          description: "Action to perform (e.g. 'execute_tool')",
        },
        tool: {
          type: "string",
          description: "Tool name to call",
        },
        params: {
          type: "object",
          description: "Tool parameters",
        },
      },
      required: ["registryId", "agentPath", "action", "tool"],
    },
    execute: async (
      input: {
        registryId: string;
        agentPath: string;
        action: string;
        tool: string;
        params?: Record<string, unknown>;
      },
      ctx: ToolContext,
    ) => {
      const { token, conn } = await getAuthenticatedToken(
        ctx.callerId,
        input.registryId,
      );
      return mcpCall(conn.url, token, {
        action: input.action,
        path: input.agentPath,
        tool: input.tool,
        params: input.params,
      });
    },
  });

  const listRemoteAgentsTool = defineTool({
    name: "list_remote_agents",
    description: "List agents available on a remote registry.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        registryId: {
          type: "string",
          description: "Registry connection ID",
        },
      },
      required: ["registryId"],
    },
    execute: async (
      input: { registryId: string },
      ctx: ToolContext,
    ) => {
      const { token, conn } = await getAuthenticatedToken(
        ctx.callerId,
        input.registryId,
      );

      const listUrl = conn.url.replace(/\/$/, "") + "/list";
      const res = await globalThis.fetch(listUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        throw new Error(`Failed to list agents: ${res.status}`);
      }

      return res.json();
    },
  });

  // ---- Agent Definition ----

  return defineAgent({
    path: "@remote-registry",
    entrypoint:
      "You manage connections to remote agent registries. " +
      "Use setup to connect a new registry, connect to register users, " +
      "and call_remote to proxy authenticated MCP calls.",
    config: {
      name: "Remote Registry",
      description:
        "Connect to remote agent registries (MCP over HTTP) for federated integrations",
      supportedActions: ["execute_tool", "describe_tools", "load"],
      integration: {
        provider: "remote-registry",
        displayName: "Agent Registry",
        icon: "server",
        category: "infrastructure",
        description:
          "Connect to a remote agent registry to access its integrations, databases, and agents.",
      },
    },
    visibility: "public",
    integrationMethods: {
      async setup(
        params: Record<string, unknown>,
        ctx: IntegrationMethodContext,
      ): Promise<IntegrationMethodResult> {
        const url = params.url as string;
        const name = (params.name as string) ?? "registry";

        if (!url) {
          return { success: false, error: "url is required" };
        }

        try {
          // 1. Create tenant on remote registry
          const setupUrl = url.replace(/\/$/, "") + "/setup";
          const setupRes = await globalThis.fetch(setupUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenant: name }),
          });

          if (!setupRes.ok) {
            const body = await setupRes.text();
            return {
              success: false,
              error: `Failed to create tenant on registry: ${setupRes.status} ${body}`,
            };
          }

          const setupResult = (await setupRes.json()) as {
            success: boolean;
            result?: {
              tenantId: string;
              token?: string;
            };
          };

          if (!setupResult.success || !setupResult.result?.tenantId) {
            return {
              success: false,
              error: "Registry /setup did not return a tenantId",
            };
          }

          const remoteTenantId = setupResult.result.tenantId;

          // 2. Register a client for this tenant
          // Use the setup token (or root key) to create client credentials
          const token = setupResult.result.token;
          if (!token) {
            return {
              success: false,
              error: "Registry /setup did not return a token for client creation",
            };
          }

          const registerResult = await mcpCall(url, token, {
            action: "execute_tool",
            path: "@auth",
            tool: "register",
            params: {
              name: `${name}-client`,
              scopes: ["integrations", "secrets", "users"],
            },
          });

          const clientId =
            registerResult?.clientId ?? registerResult?.result?.clientId;
          const clientSecret =
            registerResult?.clientSecret?.value ??
            registerResult?.result?.clientSecret?.value ??
            registerResult?.clientSecret;

          if (!clientId || !clientSecret) {
            return {
              success: false,
              error: `Failed to register client: ${JSON.stringify(registerResult)}`,
            };
          }

          // 3. Store connection
          const conn: RegistryConnection = {
            id: name,
            name,
            url: url.replace(/\/$/, ""),
            remoteTenantId,
            clientId,
            createdAt: Date.now(),
          };

          await storeConnection(ctx.callerId, conn, clientSecret);

          return {
            success: true,
            data: {
              registryId: name,
              url: conn.url,
              remoteTenantId,
              clientId,
            },
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },

      async connect(
        params: Record<string, unknown>,
        ctx: IntegrationMethodContext,
      ): Promise<IntegrationMethodResult> {
        const registryId = params.registryId as string;
        const userId = (params.userId as string) ?? ctx.callerId;

        if (!registryId) {
          return { success: false, error: "registryId is required" };
        }

        try {
          const { token, conn } = await getAuthenticatedToken(
            ctx.callerId,
            registryId,
          );

          // Register user on the remote registry
          const result = await mcpCall(conn.url, token, {
            action: "execute_tool",
            path: "@users",
            tool: "create_user",
            params: { name: userId, tenantId: conn.remoteTenantId },
          });

          return {
            success: true,
            data: {
              registryId,
              userId,
              remoteUser: result,
            },
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },

      async list(
        _params: Record<string, unknown>,
        ctx: IntegrationMethodContext,
      ): Promise<IntegrationMethodResult> {
        try {
          const conns = await listConnectionsList(ctx.callerId);
          return {
            success: true,
            data: conns.map((c) => ({
              id: c.id,
              name: c.name,
              url: c.url,
              remoteTenantId: c.remoteTenantId,
              createdAt: c.createdAt,
            })),
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },

      async get(
        params: Record<string, unknown>,
        ctx: IntegrationMethodContext,
      ): Promise<IntegrationMethodResult> {
        const registryId = params.registryId as string;
        if (!registryId) {
          return { success: false, error: "registryId is required" };
        }

        try {
          const data = await loadConnection(ctx.callerId, registryId);
          if (!data) {
            return {
              success: false,
              error: `No registry connection '${registryId}'`,
            };
          }

          return {
            success: true,
            data: {
              id: data.conn.id,
              name: data.conn.name,
              url: data.conn.url,
              remoteTenantId: data.conn.remoteTenantId,
              clientId: data.conn.clientId,
              createdAt: data.conn.createdAt,
            },
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },

      async update(
        params: Record<string, unknown>,
        ctx: IntegrationMethodContext,
      ): Promise<IntegrationMethodResult> {
        const registryId = params.registryId as string;
        if (!registryId) {
          return { success: false, error: "registryId is required" };
        }

        try {
          const data = await loadConnection(ctx.callerId, registryId);
          if (!data) {
            return {
              success: false,
              error: `No registry connection '${registryId}'`,
            };
          }

          // Update mutable fields
          if (params.name) data.conn.name = params.name as string;
          if (params.url) data.conn.url = (params.url as string).replace(/\/$/, "");

          await storeConnection(ctx.callerId, data.conn, data.clientSecret);

          return { success: true, data: { id: data.conn.id, updated: true } };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    tools: [callRemoteTool as any, listRemoteAgentsTool as any],
  });
}
