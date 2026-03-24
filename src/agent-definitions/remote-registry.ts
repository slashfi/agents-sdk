/**
 * Remote Registry Agent (JWKS Auth)
 *
 * Integration agent for connecting to remote agent registries.
 * Uses JWKS trust exchange + jwt_exchange for authentication.
 * No client credentials stored — uses signJwt for outbound calls.
 *
 * Flow:
 *   setup: discover JWKS → add trusted issuer → call @auth/create_tenant → store connection
 *   connect: POST /oauth/token jwt_exchange → identity_required → /oauth/authorize → linked
 *   proxy: sign JWT → POST to remote MCP endpoint
 *
 * @example
 * ```typescript
 * import { createRemoteRegistryAgent, createAgentServer } from '@slashfi/agents-sdk';
 *
 * const server = createAgentServer(registry, { ... });
 * await server.start();
 *
 * registry.register(createRemoteRegistryAgent({
 *   secretStore,
 *   signJwt: (claims) => server.signJwt(claims),
 * }));
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

export interface RemoteRegistryAgentOptions {
  /** Secret store for persisting registry connections */
  secretStore: SecretStore;
  /** Sign a JWT with this server's keys for outbound calls */
  signJwt: (claims: Record<string, unknown>) => Promise<string>;
  /** Add a trusted JWKS issuer (optional — for bidirectional trust) */
  addTrustedIssuer?: (issuerUrl: string) => Promise<void>;
}

/** Stored connection to a remote registry */
interface RegistryConnection {
  id: string;
  name: string;
  url: string;
  remoteTenantId: string;
  createdAt: number;
}

const ENTITY_TYPE = "remote-registry-connections";

export function createRemoteRegistryAgent(
  options: RemoteRegistryAgentOptions,
): AgentDefinition {
  const { secretStore, signJwt, addTrustedIssuer } = options;

  // --- Connection storage (KV via SecretStore) ---

  async function storeConnection(ownerId: string, conn: RegistryConnection): Promise<void> {
    console.error("[remote-registry] storeConnection for owner:", ownerId, "conn:", conn.id);
    const all = await loadAllConnections(ownerId);
    all[conn.id] = conn;
    const value = JSON.stringify(all);
    const scope = { tenantId: ownerId };
    const secretId = await secretStore.store(value, ownerId);
    if (secretStore.associate) {
      await secretStore.associate(secretId, ENTITY_TYPE, ownerId, scope);
    }
  }

  async function loadAllConnections(ownerId: string): Promise<Record<string, RegistryConnection>> {
    console.error("[remote-registry] loadAllConnections for owner:", ownerId);
    if (secretStore.resolveByEntity) {
      const scope = { tenantId: ownerId };
      const secretIds = await secretStore.resolveByEntity(ENTITY_TYPE, ownerId, scope);
      if (secretIds?.length) {
        const raw = await secretStore.resolve(secretIds[secretIds.length - 1], ownerId);
        if (raw) {
          try { return JSON.parse(raw); } catch { return {}; }
        }
      }
    }
    return {};
  }

  async function loadConnection(ownerId: string, registryId: string): Promise<RegistryConnection | null> {
    const all = await loadAllConnections(ownerId);
    return all[registryId] ?? null;
  }

  // --- MCP call helper ---

  async function mcpCall(url: string, jwt: string, request: Record<string, unknown>): Promise<any> {
    const res = await globalThis.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: "call_agent", arguments: { request } },
      }),
    });
    const rpc = await res.json() as any;
    const text = rpc.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : rpc.result;
  }

  // --- Proxy: sign JWT and call remote ---

  async function proxyCall(
    ownerId: string,
    registryId: string,
    request: { action: string; path: string; tool: string; params?: Record<string, unknown> },
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const conn = await loadConnection(ownerId, registryId);
    if (!conn) {
      return { success: false, error: `No connection '${registryId}'. Use setup_integration first.` };
    }
    const jwt = await signJwt({ tenantId: conn.remoteTenantId, action: "proxy" });
    const result = await mcpCall(conn.url, jwt, request);
    return { success: true, result };
  }

  // --- Tools ---

  const proxyTool = defineTool({
    name: "proxy_call",
    description: "Proxy an MCP call to a connected remote registry.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        registryId: { type: "string", description: "Registry connection ID" },
        action: { type: "string" },
        path: { type: "string" },
        tool: { type: "string" },
        params: { type: "object" },
      },
      required: ["registryId", "action", "path", "tool"],
    },
    execute: async (input: any, _ctx: ToolContext) => {
      return proxyCall("system", input.registryId, {
        action: input.action,
        path: input.path,
        tool: input.tool,
        params: input.params,
      });
    },
  });

  const listTool = defineTool({
    name: "list_connections",
    description: "List all connected remote registries.",
    visibility: "public" as const,
    inputSchema: { type: "object" as const, properties: {} },
    execute: async (_input: any, _ctx: ToolContext) => {
      const all = await loadAllConnections("system");
      return {
        connections: Object.values(all).map(c => ({
          id: c.id,
          name: c.name,
          url: c.url,
          remoteTenantId: c.remoteTenantId,
        })),
      };
    },
  });


  // Extract setup/connect as standalone functions to avoid circular reference
  const setupFn = async (params: Record<string, unknown>, _ctx: IntegrationMethodContext): Promise<IntegrationMethodResult> => {
    const url = params.url as string;
    const name = (params.name as string) ?? "registry";
    if (!url) return { success: false, error: "url is required" };
    try {
      const configUrl = url.replace(/\/$/, "") + "/.well-known/configuration";
      const configRes = await globalThis.fetch(configUrl);
      if (!configRes.ok) return { success: false, error: "Failed to discover registry at " + configUrl };
      const remoteConfig = await configRes.json() as any;
      if (remoteConfig.jwks_uri) {
        const jwksRes = await globalThis.fetch(remoteConfig.jwks_uri);
        if (!jwksRes.ok) return { success: false, error: "JWKS not reachable" };
      }
      if (addTrustedIssuer) await addTrustedIssuer(url.replace(/\/$/, ""));
      const jwt = await signJwt({ action: "setup", targetUrl: url });
      const tenantResult = await mcpCall(url, jwt, { action: "execute_tool", path: "/agents/@auth", tool: "create_tenant", params: { name } });
      const remoteTenantId = tenantResult?.result?.tenantId ?? tenantResult?.tenantId ?? name;
      const ownerId = "system"; // tenant-scoped
      await storeConnection(ownerId, { id: name, name, url: url.replace(/\/$/, ""), remoteTenantId, createdAt: Date.now() });
      return { success: true, data: { registryId: name, url, remoteTenantId } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const connectFn = async (params: Record<string, unknown>, ctx: IntegrationMethodContext): Promise<IntegrationMethodResult> => {
    const registryId = params.registryId as string;
    const redirectUri = (params.redirectUri as string) ?? "";
    const oidcUserId = params.oidcUserId as string | undefined;
    if (!registryId) return { success: false, error: "registryId is required" };
    try {
      const ownerId = "system"; // tenant-scoped
      const conn = await loadConnection(ownerId, registryId);
      if (!conn) return { success: false, error: "No connection '" + registryId + "'" };
      // Use OIDC-issued identity if available, never send "anonymous" as sub
      const sub = oidcUserId ?? (ctx.callerId !== "anonymous" ? ctx.callerId : undefined);
      const jwt = await signJwt({ ...(sub ? { sub } : {}), tenantId: conn.remoteTenantId, action: "connect" });
      const tokenRes = await globalThis.fetch(conn.url + "/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "jwt_exchange", assertion: jwt, redirect_uri: redirectUri }),
      });
      const tokenData = await tokenRes.json() as any;
      if (tokenData.access_token) return { success: true, data: { registryId, accessToken: tokenData.access_token, userId: tokenData.user_id, tenantId: tokenData.tenant_id } };
      if (tokenData.error === "identity_required") return { success: false, error: "identity_required", data: { authorizeUrl: tokenData.authorize_url, tenantId: tokenData.tenant_id } };
      return { success: false, error: tokenData.error_description ?? tokenData.error ?? "Token exchange failed" };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const setupTool = defineTool({
    name: "setup",
    description: "Set up a connection to a remote registry. Discovers JWKS, establishes trust, creates tenant.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Remote registry URL" },
        name: { type: "string", description: "Connection name" },
      },
      required: ["url"],
    },
    execute: async (input: any, _ctx: ToolContext) => {
      return setupFn(input, { callerId: _ctx.callerId, callerType: _ctx.callerType ?? "user", provider: "remote-registry", tenantId: ((_ctx) as any).tenantId ?? "system", agentPath: "@remote-registry" });
    },
  });

  const connectTool = defineTool({
    name: "connect",
    description: "Connect a user to a remote registry via jwt_exchange. Returns access_token or identity_required.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        registryId: { type: "string", description: "Registry connection ID" },
        redirectUri: { type: "string", description: "Redirect URI after OAuth" },
        oidcUserId: { type: "string", description: "OIDC-issued user ID (from completed identity linking)" },
      },
      required: ["registryId"],
    },
    execute: async (input: any, _ctx: ToolContext) => {
      return connectFn(input, { callerId: _ctx.callerId, callerType: _ctx.callerType ?? "user", provider: "remote-registry", tenantId: ((_ctx) as any).tenantId ?? "system", agentPath: "@remote-registry" });
    },
  });

  return defineAgent({
    path: "@remote-registry",
    entrypoint:
      "You manage connections to remote agent registries. " +
      "Use setup to connect a new registry, connect to link user identities, " +
      "and proxy_call to make authenticated calls.",
    config: {
      name: "Remote Registry",
      description: "Connect to remote agent registries via JWKS trust + jwt_exchange",
      supportedActions: ["execute_tool", "describe_tools", "load"],
      integration: {
        provider: "remote-registry",
        displayName: "Agent Registry",
        icon: "server",
        category: "infrastructure",
        description: "Connect to a remote agent registry via JWKS trust exchange.",
      },
    },
    visibility: "public",
    integrationMethods: {
      async setup(
        params: Record<string, unknown>,
        _ctx: IntegrationMethodContext,
      ): Promise<IntegrationMethodResult> {
        return setupFn(params, _ctx);
      },

      async connect(
        params: Record<string, unknown>,
        _ctx: IntegrationMethodContext,
      ): Promise<IntegrationMethodResult> {
        return connectFn(params, _ctx);
      },

      async list(
        _params: Record<string, unknown>,
        _ctx: IntegrationMethodContext,
      ): Promise<IntegrationMethodResult> {
        const all = await loadAllConnections("system");
        return {
          success: true,
          data: {
            connections: Object.values(all).map(c => ({
              id: c.id,
              name: c.name,
              url: c.url,
              remoteTenantId: c.remoteTenantId,
            })),
          },
        };
      },

      async get(
        params: Record<string, unknown>,
        _ctx: IntegrationMethodContext,
      ): Promise<IntegrationMethodResult> {
        const registryId = params.registryId as string;
        if (!registryId) return { success: false, error: "registryId is required" };
        const ownerId = _ctx.callerId ?? "system";
        const conn = await loadConnection(ownerId, registryId);
        if (!conn) return { success: false, error: `No connection '${registryId}'` };
        return { success: true, data: conn };
      },

      async update(
        _params: Record<string, unknown>,
        _ctx: IntegrationMethodContext,
      ): Promise<IntegrationMethodResult> {
        return { success: false, error: "Not implemented" };
      },
    },
    tools: [setupTool, connectTool, proxyTool, listTool] as any[],
  });
}
