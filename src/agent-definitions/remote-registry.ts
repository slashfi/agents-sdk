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
    const jwt = await signJwt({ tenantId: conn.remoteTenantId, action: "proxy", type: "agent-registry" });
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

  const addConnectionTool = defineTool({
    name: "add_connection",
    description: "Directly store a connection to a remote registry (no OAuth exchange). Used for reverse registration.",
    visibility: "public" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Connection ID" },
        name: { type: "string", description: "Display name" },
        url: { type: "string", description: "Remote registry URL" },
        remoteTenantId: { type: "string", description: "Tenant ID on the remote side" },
      },
      required: ["id", "url"],
    },
    execute: async (input: any, _ctx: ToolContext) => {
      const conn: RegistryConnection = {
        id: input.id,
        name: input.name ?? input.id,
        url: input.url.replace(/\/$/, ""),
        remoteTenantId: input.remoteTenantId ?? input.id,
        createdAt: Date.now(),
      };
      await storeConnection("system", conn);
      return { success: true, data: conn };
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
    console.log("[remote-registry] setupFn called with:", JSON.stringify(params));
    const url = params.url as string;
    const name = (params.name as string) ?? "registry";
    const oidcUserId = params.oidcUserId as string | undefined;
    if (!url) return { success: false, error: "url is required" };
    try {
      const baseUrl = url.replace(/\/$/, "");

      // Phase 2: Complete setup after OIDC — store connection with resolved tenant
      if (oidcUserId) {
        const jwt = await signJwt({ sub: oidcUserId, action: "setup", type: "agent-registry" });
        const tokenRes = await globalThis.fetch(baseUrl + "/oauth/token", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "jwt_exchange", assertion: jwt, scope: "setup", redirect_uri: params.redirect_uri ?? "" }),
        });
        const tokenData = await tokenRes.json() as any;
        if (!tokenData.access_token && !tokenData.tenant_id) {
          return { success: false, error: tokenData.error_description ?? tokenData.error ?? "Setup completion failed" };
        }
        const remoteTenantId = tokenData.tenant_id ?? name;
        const ownerId = "system";
        await storeConnection(ownerId, { id: name, name, url: baseUrl, remoteTenantId, createdAt: Date.now() });
        return { success: true, data: { registryId: name, url, remoteTenantId } };
      }

      // Phase 1: Discover JWKS, establish trust, then request OIDC
      const configUrl = baseUrl + "/.well-known/configuration";
      console.log("[setupFn] fetching config:", configUrl);
      const configRes = await globalThis.fetch(configUrl);
      console.log("[setupFn] config status:", configRes.status);
      if (!configRes.ok) return { success: false, error: "Failed to discover registry at " + configUrl };
      const remoteConfig = await configRes.json() as any;
      if (remoteConfig.jwks_uri) {
        console.log("[setupFn] fetching JWKS:", remoteConfig.jwks_uri);
        const jwksRes = await globalThis.fetch(remoteConfig.jwks_uri);
        console.log("[setupFn] JWKS status:", jwksRes.status);
        if (!jwksRes.ok) return { success: false, error: "JWKS not reachable" };
      }
      if (addTrustedIssuer) { console.log("[setupFn] adding trusted issuer:", baseUrl); await addTrustedIssuer(baseUrl); console.log("[setupFn] added trusted issuer"); }

      // Request identity — atlas will return authorize URL for Slack OIDC
      console.log("[setupFn] Phase 1: requesting identity via jwt_exchange");
      const jwt = await signJwt({ action: "setup", type: "agent-registry", targetUrl: url });
      console.log("[setupFn] POSTing to:", baseUrl + "/oauth/token");
      const tokenRes = await globalThis.fetch(baseUrl + "/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "jwt_exchange", assertion: jwt, scope: "setup", redirect_uri: params.redirect_uri ?? "" }),
      });
      console.log("[setupFn] token status:", tokenRes.status);
      const tokenData = await tokenRes.json() as any;
      console.log("[setupFn] tokenData:", JSON.stringify(tokenData).substring(0, 300));

      // If already set up (user linked), store connection directly
      if (tokenData.access_token) {
        const remoteTenantId = tokenData.tenant_id ?? name;
        const ownerId = "system";
        await storeConnection(ownerId, { id: name, name, url: baseUrl, remoteTenantId, createdAt: Date.now() });
        return { success: true, data: { registryId: name, url, remoteTenantId } };
      }

      // Need OIDC — return authorize URL to caller
      if (tokenData.error === "identity_required") {
        return { success: false, error: "identity_required", data: { authorizeUrl: tokenData.authorize_url, registryId: name, url } };
      }

      return { success: false, error: tokenData.error_description ?? tokenData.error ?? "Unexpected response from token endpoint" };
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
      const jwt = await signJwt({ ...(sub ? { sub } : {}), tenantId: conn.remoteTenantId, action: "connect", type: "agent-registry" });
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
    },
    visibility: "public",
    integration: {
      provider: "remote-registry",
      displayName: "Agent Registry",
      icon: "server",
      category: "infrastructure",
      description: "Connect to a remote agent registry via JWKS trust exchange.",
      setup: (params, ctx) => setupFn(params, ctx as any),
      connect: (params, ctx) => connectFn(params, ctx as any),
      async discover(params) {
        const url = (params.url as string) ?? "";
        try {
          const res = await globalThis.fetch(url.replace(/\/$/, "") + "/.well-known/configuration");
          if (!res.ok) return { success: false, error: "No configuration endpoint at " + url };
          const config = await res.json() as any;
          return { success: true, data: { url, issuer: config.issuer, grantTypes: config.supported_grant_types, jwksUri: config.jwks_uri } };
        } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; }
      },
      async list() {
        const all = await loadAllConnections("system");
        return { success: true, data: { connections: Object.values(all).map(c => ({ id: c.id, name: c.name, url: c.url, remoteTenantId: c.remoteTenantId })) } };
      },
      async get(params) {
        const id = (params.registryId as string) ?? "";
        const conn = await loadConnection("system", id);
        if (!conn) return { success: false, error: "No connection '" + id + "'" };
        return { success: true, data: conn };
      },
      async update(params) {
        const id = (params.registryId as string) ?? "";
        const conn = await loadConnection("system", id);
        if (!conn) return { success: false, error: "No connection '" + id + "'" };
        if (params.name) conn.name = params.name as string;
        if (params.url) conn.url = params.url as string;
        await storeConnection("system", conn);
        return { success: true, data: conn };
      },
    },
    tools: [proxyTool, listTool, addConnectionTool] as any[],
  });
}
