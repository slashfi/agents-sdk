/**
 * Agent Server (MCP over HTTP)
 *
 * JSON-RPC server implementing the MCP protocol for agent interaction.
 * Compatible with atlas-environments and any MCP client.
 *
 * MCP Methods:
 * - initialize       → Protocol handshake
 * - tools/list        → List available MCP tools (call_agent, list_agents)
 * - tools/call        → Execute an MCP tool
 *
 * MCP Tools exposed:
 * - call_agent   → Execute a tool on a registered agent
 * - list_agents  → List registered agents and their tools
 *
 * Additional endpoints:
 * - POST /oauth/token             → OAuth2 client_credentials (when @auth registered)
 * - GET  /oauth/callback          → Unified OAuth callback (provider from state)
 * - GET  /integrations/callback/* → Legacy OAuth callback (provider from URL path)
 * - GET  /health                  → Health check
 *
 * Auth Integration:
 * When an `@auth` agent is registered, the server automatically:
 * - Validates Bearer tokens on requests
 * - Resolves tokens to identity + scopes
 * - Populates caller context from headers (X-Atlas-Actor-Id, etc.)
 * - Recognizes the root key for admin access
 */

import type { AuthStore } from "./agent-definitions/auth.js";
import {
  type SecretStore,
  processSecretParams,
} from "./agent-definitions/secrets.js";
import { verifyJwt, verifyJwtLocal, verifyJwtFromIssuer, buildJwks, generateSigningKey, exportSigningKey, importSigningKey, type SigningKey } from "./jwt.js";
import type { AgentRegistry } from "./registry.js";
import type { AgentDefinition, CallAgentRequest, Visibility } from "./types.js";
import { renderLoginPage, renderDashboardPage, renderTenantPage } from "./web-pages.js";


function resolveBaseUrl(req: Request, url: URL): string {
  const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || url.host;
  return `${proto}://${host}`;
}

// ============================================
// Server Types
// ============================================

export interface AgentServerOptions {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Hostname to bind to (default: 'localhost') */
  hostname?: string;
  /** Base path for endpoints (default: '') */
  basePath?: string;
  /** Enable CORS (default: true) */
  cors?: boolean;
  /** Server name reported in MCP initialize (default: 'agents-sdk') */
  serverName?: string;
  /** Server version reported in MCP initialize (default: '1.0.0') */
  serverVersion?: string;

  /** Secret store for handling secret: refs in tool params */
  secretStore?: SecretStore;
  /** Trusted issuer URLs for cross-registry JWT verification */
  trustedIssuers?: string[];
  /** Pre-generated signing key (otherwise auto-generated on start) */
  signingKey?: SigningKey;
}

export interface AgentServer {
  /** Start the server */
  start(): Promise<void>;
  /** Stop the server */
  stop(): Promise<void>;
  /** Handle a request (for custom integrations) */
  fetch(req: Request): Promise<Response>;
  /** Get the server URL (only available after start) */
  url: string | null;
}

// ============================================
// JSON-RPC Types
// ============================================

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ============================================
// Auth Types
// ============================================

interface AuthConfig {
  store: AuthStore;
  rootKey: string;
  tokenTtl: number;
}

interface ResolvedAuth {
  callerId: string;
  callerType: "agent" | "user" | "system";
  scopes: string[];
  isRoot: boolean;
}


// ============================================
// Secrets Collection (one-time tokens)
// ============================================


function escHtml(s: string): string {
  return s.replace(/&/g,"\&amp;").replace(/</g,"\&lt;").replace(/>/g,"\&gt;").replace(/"/g,"\&quot;");
}

function renderSecretForm(token: string, pending: PendingCollection, baseUrl: string): string {
  const fields = pending.fields.map(f => `
    <div class="field">
      <label>${escHtml(f.name)}${f.secret ? ` <span class="badge">SECRET</span>` : ""}${f.required ? ` <span class="req">*</span>` : ""}</label>
      ${f.description ? `<p class="desc">${escHtml(f.description)}</p>` : ""}
      <input type="${f.secret ? "password" : "text"}" name="${escHtml(f.name)}" ${f.required ? "required" : ""} autocomplete="off" />
    </div>`).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure Setup</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:480px;width:100%}.header{display:flex;align-items:center;gap:12px;margin-bottom:8px}.lock{font-size:24px}h1{font-size:20px;font-weight:600}.subtitle{color:#8b949e;font-size:14px;margin-bottom:24px}.shield{display:inline-flex;align-items:center;gap:4px;background:#1a2332;border:1px solid #1f6feb33;color:#58a6ff;font-size:12px;padding:2px 8px;border-radius:12px;margin-bottom:20px}label{display:block;font-size:14px;font-weight:500;margin-bottom:6px}.desc{font-size:12px;color:#8b949e;margin-bottom:4px}.badge{background:#3d1f00;color:#f0883e;font-size:10px;padding:1px 6px;border-radius:4px}.req{color:#f85149}input{width:100%;padding:10px 12px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:14px;margin-bottom:16px;outline:none}input:focus{border-color:#58a6ff;box-shadow:0 0 0 3px #1f6feb33}button{width:100%;padding:12px;background:#238636;border:none;border-radius:6px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}button:hover{background:#2ea043}button:disabled{opacity:.5;cursor:not-allowed}.footer{text-align:center;margin-top:16px;font-size:12px;color:#484f58}.error{background:#3d1418;border:1px solid #f8514966;color:#f85149;padding:10px 12px;border-radius:6px;font-size:13px;margin-bottom:16px;display:none}.ok{text-align:center;padding:40px 0}.ok .icon{font-size:48px;margin-bottom:12px}.ok h2{font-size:18px;margin-bottom:8px;color:#3fb950}.ok p{color:#8b949e;font-size:14px}.field{position:relative}</style></head><body>
<div class="card" id="fc"><div class="header"><span class="lock">🔐</span><h1>${escHtml(pending.tool)} on ${escHtml(pending.agent)}</h1></div>
<p class="subtitle">Enter credentials below. They are encrypted and stored securely — they never pass through the AI.</p>
<div class="shield">🛡️ End-to-end encrypted</div><div id="err" class="error"></div>
<form id="f">${fields}<button type="submit">Submit Securely</button></form>
<p class="footer">Expires in 10 minutes</p></div>
<div class="card ok" id="ok" style="display:none"><div class="icon">✅</div><h2>Done</h2><p>Credentials stored securely. You can close this window.</p></div>
<script>document.getElementById("f").addEventListener("submit",async e=>{e.preventDefault();const b=e.target.querySelector("button");b.disabled=true;b.textContent="Submitting...";try{const fd=new FormData(e.target),vals=Object.fromEntries(fd.entries());const r=await fetch("${baseUrl}/secrets/collect",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:"${token}",values:vals})});const d=await r.json();if(d.success){document.getElementById("fc").style.display="none";document.getElementById("ok").style.display="block";}else throw new Error(d.error?.message||JSON.stringify(d));}catch(err){const el=document.getElementById("err");el.textContent=err.message;el.style.display="block";b.disabled=false;b.textContent="Submit Securely";}});</script></body></html>`;
}

export interface PendingCollection {
  /** Partial params already provided by agent */
  params: Record<string, unknown>;
  /** Target agent + tool to call after collection */
  agent: string;
  tool: string;
  /** Auth context from original request */
  auth: ResolvedAuth | null;
  /** Fields the form needs to collect */
  fields: Array<{ name: string; description?: string; secret: boolean; required: boolean }>;
  /** Created timestamp for expiry */
  createdAt: number;
}

export const pendingCollections = new Map<string, PendingCollection>();

export function generateCollectionToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "sc_";
  for (let i = 0; i < 32; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// ============================================
// Helpers
// ============================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Atlas-Actor-Id, X-Atlas-Agent-Id, X-Atlas-Session-Id",
  };
}

function jsonRpcSuccess(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined && { data }) },
  };
}

/** Wrap a value as MCP tool result content */
function mcpResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError && { isError: true }),
  };
}

// ============================================
// Auth Detection
// ============================================

function detectAuth(registry: AgentRegistry): AuthConfig | null {
  const authAgent = registry.get("@auth") as
    | (AgentDefinition & {
        __authStore?: AuthStore;
        __rootKey?: string;
        __tokenTtl?: number;
      })
    | undefined;

  if (!authAgent?.__authStore || !authAgent.__rootKey) return null;

  return {
    store: authAgent.__authStore,
    rootKey: authAgent.__rootKey,
    tokenTtl: authAgent.__tokenTtl ?? 3600,
  };
}

async function resolveAuth(
  req: Request,
  authConfig: AuthConfig,
): Promise<ResolvedAuth | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const [scheme, credential] = authHeader.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !credential) return null;

  if (credential === authConfig.rootKey) {
    return {
      callerId: "root",
      callerType: "system",
      scopes: ["*"],
      isRoot: true,
    };
  }

  // Try JWT verification first (stateless)
  // JWT is signed with the client's secret hash
  // Decode payload to get client_id, look up client, verify signature
  const parts = credential.split(".");
  if (parts.length === 3) {
    // Looks like a JWT - decode payload to get client_id
    try {
      const payloadB64 = parts[1];
      const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(padded)) as {
        sub?: string;
        name?: string;
        scopes?: string[];
        exp?: number;
      };

      if (payload.sub) {
        // Look up client to get the signing secret (secret hash)
        const client = await authConfig.store.getClient(payload.sub);
        if (client) {
          const verified = await verifyJwt(credential, client.clientSecretHash);
          if (verified) {
            return {
              callerId: verified.name || client.name,
              callerType: "agent",
              scopes: verified.scopes,
              isRoot: false,
            };
          }
        }
      }
    } catch {
      // Not a valid JWT, fall through to HMAC
    }


  }

  // Legacy: opaque token validation (backwards compat)
  const token = await authConfig.store.validateToken(credential);
  if (!token) return null;

  const client = await authConfig.store.getClient(token.clientId);
  return {
    callerId: client?.name ?? token.clientId,
    callerType: "agent",
    scopes: token.scopes,
    isRoot: false,
  };
}

function canSeeAgent(
  agent: AgentDefinition,
  auth: ResolvedAuth | null,
): boolean {
  const visibility = ((agent as any).visibility ??
    agent.config?.visibility ??
    "internal") as Visibility;
  if (auth?.isRoot) return true;
  if (visibility === "public") return true;
  if (visibility === "internal" && auth) return true;
  return false;
}

// ============================================
// MCP Tool Definitions
// ============================================

function getToolDefinitions() {
  return [
    {
      name: "call_agent",
      description:
        "Execute a tool on a registered agent. Provide the agent path and tool name.",
      inputSchema: {
        type: "object",
        properties: {
          request: {
            type: "object",
            description: "The call request",
            properties: {
              action: {
                type: "string",
                enum: ["execute_tool", "describe_tools", "load"],
                description: "Action to perform",
              },
              path: {
                type: "string",
                description: "Agent path (e.g. '@registry')",
              },
              tool: {
                type: "string",
                description: "Tool name to call (for execute_tool)",
              },
              params: {
                type: "object",
                description: "Parameters for the tool",
                additionalProperties: true,
              },
            },
            required: ["action", "path"],
          },
        },
        required: ["request"],
      },
    },
    {
      name: "list_agents",
      description: "List all registered agents and their available tools.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

// ============================================
// Create Server
// ============================================

export function createAgentServer(
  registry: AgentRegistry,
  options: AgentServerOptions = {},
): AgentServer {
  const {
    port = 3000,
    hostname = "localhost",
    basePath = "",
    cors = true,
    serverName = "agents-sdk",
    serverVersion = "1.0.0",
    secretStore,
  } = options;

  // Signing keys loaded from store (populated in start())
  const serverSigningKeys: SigningKey[] = [];
  // Trusted issuers from config (store can add more at runtime)
  const configTrustedIssuers: string[] = options.trustedIssuers ?? [];

  let serverInstance: ReturnType<typeof Bun.serve> | null = null;
  let serverUrl: string | null = null;

  const authConfig = detectAuth(registry);

  // ──────────────────────────────────────────
  // MCP JSON-RPC handler
  // ──────────────────────────────────────────

  async function handleJsonRpc(
    request: JsonRpcRequest,
    auth: ResolvedAuth | null,
  ): Promise<JsonRpcResponse> {
    switch (request.method) {
      // MCP protocol handshake
      case "initialize":
        return jsonRpcSuccess(request.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: serverVersion },
        });

      case "notifications/initialized":
        return jsonRpcSuccess(request.id, {});

      // List MCP tools
      case "tools/list":
        return jsonRpcSuccess(request.id, {
          tools: getToolDefinitions(),
        });

      // Call an MCP tool
      case "tools/call": {
        const { name, arguments: args } = (request.params ?? {}) as {
          name: string;
          arguments?: Record<string, unknown>;
        };

        try {
          const result = await handleToolCall(name, args ?? {}, auth);
          return jsonRpcSuccess(request.id, result);
        } catch (err) {
          console.error("[server] Request error:", err);
          return jsonRpcSuccess(
            request.id,
            mcpResult(
              `Error: ${err instanceof Error ? err.message : String(err)}`,
              true,
            ),
          );
        }
      }

      default:
        return jsonRpcError(
          request.id,
          -32601,
          `Method not found: ${request.method}`,
        );
    }
  }

  // ──────────────────────────────────────────
  // MCP tool implementations
  // ──────────────────────────────────────────

  async function handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    auth: ResolvedAuth | null,
  ) {
    switch (toolName) {
      case "call_agent": {
        const req = (args.request ?? args) as CallAgentRequest;

        // Inject auth context
        if (auth) {
          req.callerId = auth.callerId;
          req.callerType = auth.callerType;
          if (!req.metadata) req.metadata = {};
          req.metadata.scopes = auth.scopes;
          req.metadata.isRoot = auth.isRoot;
        }
        if (auth?.isRoot) {
          req.callerType = "system";
        }

        // Process secret params: resolve refs, store raw secrets
        // Auto-resolve secret:xxx refs in tool params before execution
        if ((req as any).params && secretStore) {
          const ownerId = auth?.callerId ?? "anonymous";
          // Find the tool schema to check for secret: true fields
          const agent = registry.get(req.path);
          const tool = agent?.tools.find((t) => t.name === (req as any).tool);
          const schema = tool?.inputSchema as any;
          const { resolved } = await processSecretParams(
            (req as any).params as Record<string, unknown>,
            schema,
            secretStore,
            ownerId,
          );
          (req as any).params = resolved;
        }

        const result = await registry.call(req);
        return mcpResult(result);
      }

      case "list_agents": {
        const agents = registry.list();
        const visible = agents.filter((agent) => canSeeAgent(agent, auth));

        return mcpResult({
          success: true,
          agents: visible.map((agent) => ({
            path: agent.path,
            name: agent.config?.name,
            description: agent.config?.description,
            supportedActions: agent.config?.supportedActions,
            integration: agent.config?.integration || null,
            tools: agent.tools
              .filter((t) => {
                const tv = t.visibility ?? "internal";
                if (auth?.isRoot) return true;
                if (tv === "public") return true;
                if (tv === "internal" && auth) return true;
                return false;
              })
              .map((t) => t.name),
          })),
        });
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ──────────────────────────────────────────
  // OAuth2 token handler (unchanged)
  // ──────────────────────────────────────────

  async function handleOAuthToken(req: Request): Promise<Response> {
    if (!authConfig) {
      return jsonResponse({ error: "auth_not_configured" }, 404);
    }

    const contentType = req.headers.get("Content-Type") ?? "";
    let grantType: string;
    let clientId: string;
    let clientSecret: string;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const body = await req.text();
      const params = new URLSearchParams(body);
      grantType = params.get("grant_type") ?? "";
      clientId = params.get("client_id") ?? "";
      clientSecret = params.get("client_secret") ?? "";
    } else {
      const body = (await req.json()) as Record<string, string>;
      grantType = body.grant_type ?? "";
      clientId = body.client_id ?? "";
      clientSecret = body.client_secret ?? "";
    }

    if (grantType !== "client_credentials") {
      return jsonResponse(
        {
          error: "unsupported_grant_type",
          error_description: "Only client_credentials is supported",
        },
        400,
      );
    }

    if (!clientId || !clientSecret) {
      return jsonResponse(
        {
          error: "invalid_request",
          error_description: "Missing client_id or client_secret",
        },
        400,
      );
    }

    const client = await authConfig.store.validateClient(
      clientId,
      clientSecret,
    );
    if (!client) {
      return jsonResponse(
        {
          error: "invalid_client",
          error_description: "Invalid client credentials",
        },
        401,
      );
    }

    // Delegate to @auth agent's token tool which generates proper JWTs
    const tokenResult = await registry.call({
      action: "execute_tool",
      path: "@auth",
      tool: "token",
      params: {
        grantType: "client_credentials",
        clientId,
        clientSecret,
      },
      context: {
        tenantId: "default",
        agentPath: "@auth",
        callerId: "oauth_endpoint",
        callerType: "system",
      },
    } as any);

    // Extract the result - registry.call returns { success, result: { accessToken, tokenType, expiresIn, scopes } }
    const callResponse = tokenResult as any;
    if (!callResponse.success) {
      return jsonResponse({ error: "token_generation_failed", error_description: callResponse.error ?? "Unknown error" }, 500);
    }
    const tokenData = callResponse.result;

    // accessToken may be wrapped as { $agent_type: "secret", value: "<jwt>" }
    const accessToken = tokenData.accessToken?.$agent_type === "secret"
      ? tokenData.accessToken.value
      : tokenData.accessToken;

    return jsonResponse({
      access_token: accessToken,
      token_type: tokenData.tokenType ?? "Bearer",
      expires_in: tokenData.expiresIn ?? authConfig.tokenTtl,
      scope: Array.isArray(tokenData.scopes) ? tokenData.scopes.join(" ") : client.scopes.join(" "),
    });
  }

  // ──────────────────────────────────────────
  // HTTP request handler
  // ─��────────────────────────────────────────

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(basePath, "") || "/";

    // CORS preflight
    if (cors && req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const addCors = (response: Response): Response => {
      if (!cors) return response;
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders())) {
        headers.set(key, value);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };

    let auth = authConfig ? await resolveAuth(req, authConfig) : null;

    // If HMAC auth failed, try ES256 verification (asymmetric keys)
    if (!auth) {
      const authHeader = req.headers.get("Authorization");
      const credential = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (credential) {
        // Try own signing keys
        for (const sk of serverSigningKeys) {
          const verified = await verifyJwtLocal(credential, sk.publicKey);
          if (verified) {
            auth = {
              callerId: verified.userId || verified.sub || verified.name || "unknown",
              callerType: "agent",
              scopes: verified.scopes || [],
              isRoot: false,
            };
            break;
          }
        }
        // Try trusted issuers' JWKS — check the JWT's iss claim
        if (!auth) {
          try {
            // Decode payload to read iss (without verifying — verification happens next)
            const [, payloadB64] = credential.split(".");
            const decoded = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
            const storedIssuers = await authConfig?.store?.listTrustedIssuers?.() ?? configTrustedIssuers;
            if (decoded.iss && storedIssuers.includes(decoded.iss)) {
              const verified = await verifyJwtFromIssuer(credential, decoded.iss);
              if (verified) {
                auth = {
                  callerId: verified.userId || verified.sub || verified.name || "unknown",
                  callerType: "agent",
                  scopes: verified.scopes || [],
                  isRoot: false,
                };
              }
            }
          } catch {
            // Not a valid JWT, skip
          }
        }
      }
    }

    try {
      // MCP endpoint: POST / or POST /mcp
      if ((path === "/" || path === "/mcp") && req.method === "POST") {
        const body = (await req.json()) as JsonRpcRequest;
        const response = await handleJsonRpc(body, auth);
        return addCors(jsonResponse(response));
      }

      // OAuth2 token endpoint
      if (path === "/oauth/token" && req.method === "POST") {
        return addCors(await handleOAuthToken(req));
      }

      // Health check
      if (path === "/health" && req.method === "GET") {
        return addCors(jsonResponse({ status: "ok" }));
      }

      // JWKS endpoint — public keys for JWT verification
      if (path === "/.well-known/jwks.json" && req.method === "GET") {
        const jwks = serverSigningKeys.length > 0
          ? await buildJwks(serverSigningKeys)
          : { keys: [] };
        return addCors(jsonResponse(jwks));
      }

      // Discovery endpoint — registry metadata
      if (path === "/.well-known/configuration" && req.method === "GET") {
        const reqUrl = new URL(req.url);
        const baseUrl = resolveBaseUrl(req, reqUrl);
        const agents = registry.list();
        return addCors(jsonResponse({
          issuer: baseUrl,
          jwks_uri: `${baseUrl}/.well-known/jwks.json`,
          call_endpoint: "/call",
          list_endpoint: "/list",
          token_endpoint: "/oauth/token",
          health_endpoint: "/health",
          agents: agents.map(a => ({
            path: a.path,
            name: a.config?.name,
            description: a.config?.description,
            integration: a.config?.integration || null,
          })),
        }));
      }

      // Backwards compat: GET /list (returns agents directly)
      if (path === "/list" && req.method === "GET") {
        const agents = registry.list();
        const visible = agents.filter((agent) => canSeeAgent(agent, auth));
        return addCors(
          jsonResponse({
            success: true,
            agents: visible.map((agent) => ({
              path: agent.path,
              name: agent.config?.name,
              description: agent.config?.description,
              supportedActions: agent.config?.supportedActions,
              integration: agent.config?.integration || null,
              tools: agent.tools
                .filter((t) => {
                  const tv = t.visibility ?? "internal";
                  if (auth?.isRoot) return true;
                  if (tv === "public") return true;
                  if (tv === "internal" && auth) return true;
                  return false;
                })
                .map((t) => t.name),
            })),
          }),
        );
      }


      // ---- Shared OAuth callback handler ----
      async function handleIntegrationOAuthCallback(provider: string, req: Request): Promise<Response> {
        const url = new URL(req.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const oauthError = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        if (oauthError) {
          return new Response(
            `<html><body><h1>Authorization Failed</h1><p>${errorDescription ?? oauthError}</p></body></html>`,
            { status: 400, headers: { "Content-Type": "text/html", ...corsHeaders() } },
          );
        }

        if (!code) {
          return addCors(jsonResponse({ error: "Missing authorization code" }, 400));
        }

        try {
          await registry.call({
            action: "execute_tool",
            path: "@integrations",
            tool: "handle_oauth_callback",
            params: { provider, code, state: state ?? undefined },
            context: {
              tenantId: "default",
              agentPath: "@integrations",
              callerId: "oauth_callback",
              callerType: "system",
            },
          } as any);

          // Parse redirect URL from state (base64-encoded JSON)
          let redirectUrl = "/";
          if (state) {
            try {
              const parsed = JSON.parse(atob(state));
              if (parsed.redirectUrl) redirectUrl = parsed.redirectUrl;
            } catch {
              // Fallback: try raw JSON for backward compat
              try {
                const parsed = JSON.parse(state);
                if (parsed.redirectUrl) redirectUrl = parsed.redirectUrl;
              } catch {}
            }
          }

          // If this is a sign-in flow (type: 'auth'), handle user/session creation
          let stateType: string | undefined;
          if (state) {
            try {
              const parsed = JSON.parse(atob(state));
              stateType = parsed.type;
            } catch {
              try { stateType = JSON.parse(state).type; } catch {}
            }
          }

          if (stateType === "auth" && provider === "slack") {
            // Slack sign-in: exchange the stored tokens for user profile + create session
            try {
              // Get the stored connection to retrieve the access token
              const connectionResult = await registry.call({
                action: "execute_tool",
                path: "@integrations",
                tool: "list_integrations",
                params: {},
                context: { tenantId: "default", agentPath: "@integrations", callerId: "oauth_callback", callerType: "system" },
              } as any) as any;

              // Get the Slack access token from the connection
              const slackConn = (connectionResult?.result?.connections || connectionResult?.result || [])
                .find((c: any) => c.providerId === "slack" || c.provider === "slack");
              const slackToken = slackConn?.accessToken;

              if (slackToken) {
                // Fetch Slack user profile using the stored token
                const profileRes = await globalThis.fetch("https://slack.com/api/openid.connect.userInfo", {
                  headers: { Authorization: `Bearer ${slackToken}` },
                });
                const profile = await profileRes.json() as any;
                if (profile.ok) {
                  const teamId = profile["https://slack.com/team_id"] || "";
                  const teamName = profile["https://slack.com/team_name"] || "";

                  // Check if user already exists
                  const existing = await registry.call({
                    action: "execute_tool", path: "@users", callerType: "system", tool: "resolve_identity",
                    params: { provider: "slack", providerUserId: profile.sub },
                  } as any) as any;

                  if (existing?.result?.found && existing?.result?.user?.tenantId) {
                    // Returning user
                    const mcpToken = await generateMcpToken();
                    return sessionRedirect(redirectUrl || `${baseUrl}/dashboard`, {
                      userId: existing.result.user.id,
                      tenantId: existing.result.user.tenantId,
                      email: existing.result.user.email,
                      name: existing.result.user.name,
                      token: mcpToken,
                    });
                  }

                  // Check if team already has a tenant
                  if (teamId && process.env.DATABASE_URL) {
                    try {
                      const { default: postgres } = await import("postgres");
                      const sql = postgres(process.env.DATABASE_URL);
                      const rows = await sql`SELECT tenant_id FROM tenant_identities WHERE provider = 'slack' AND provider_org_id = ${teamId} LIMIT 1`;
                      await sql.end();
                      if (rows.length > 0) {
                        const existingTenantId = rows[0].tenant_id;
                        const userRes = await registry.call({ action: "execute_tool", path: "@users", callerType: "system", tool: "create_user", params: {
                          email: profile.email, name: profile.name, tenantId: existingTenantId,
                        }} as any) as any;
                        const newUserId = userRes?.result?.id || userRes?.result?.user?.id;
                        if (newUserId) {
                          await registry.call({ action: "execute_tool", path: "@users", callerType: "system", tool: "link_identity", params: {
                            userId: newUserId, provider: "slack", providerUserId: profile.sub,
                            email: profile.email, name: profile.name,
                            metadata: { slackTeamId: teamId, slackTeamName: teamName },
                          }} as any);
                        }
                        const mcpToken = await generateMcpToken();
                        return sessionRedirect(redirectUrl || `${baseUrl}/dashboard`, {
                          userId: newUserId, tenantId: existingTenantId,
                          email: profile.email, name: profile.name, token: mcpToken,
                        });
                      }
                    } catch (e: any) {
                      console.error("[auth] tenant_identity lookup error:", e.message);
                    }
                  }

                  // New user — redirect to setup
                  return sessionRedirect(`${baseUrl}/setup`, {
                    email: profile.email,
                    name: profile.name,
                    picture: profile.picture,
                    slackUserId: profile.sub,
                    slackTeamId: teamId,
                    slackTeamName: teamName,
                  });
                }
              }
            } catch (authErr: any) {
              console.error("[auth] Slack sign-in post-callback error:", authErr);
            }
          }

          const sep = redirectUrl.includes("?") ? "&" : "?";
          return Response.redirect(`${redirectUrl}${sep}connected=${provider}`, 302);
        } catch (err) {
          return new Response(
            `<html><body><h1>Connection Failed</h1><p>${err instanceof Error ? err.message : String(err)}</p></body></html>`,
            { status: 500, headers: { "Content-Type": "text/html", ...corsHeaders() } },
          );
        }
      }

      // GET /oauth/callback - Unified OAuth callback (provider from state param)
      if (path === "/oauth/callback" && req.method === "GET") {
        const url = new URL(req.url);
        const state = url.searchParams.get("state");
        let provider: string | undefined;
        if (state) {
          try {
            const parsed = JSON.parse(atob(state));
            provider = parsed.providerId;
          } catch {
            // Fallback: try raw JSON for backward compat
            try {
              const parsed = JSON.parse(state);
              provider = parsed.providerId;
            } catch {}
          }
        }
        if (!provider) {
          return addCors(jsonResponse({ error: "Missing provider in state param" }, 400));
        }
        return handleIntegrationOAuthCallback(provider, req);
      }

      // GET /integrations/callback/:provider - Legacy OAuth callback (provider from URL path)
      if (path.startsWith("/integrations/callback/") && req.method === "GET") {
        const provider = path.split("/integrations/callback/")[1]?.split("?")[0];
        if (!provider) {
          return addCors(jsonResponse({ error: "Missing provider" }, 400));
        }
        return handleIntegrationOAuthCallback(provider, req);
      }


      // GET /secrets/form/:token - Serve hosted secrets form
      if (path.startsWith("/secrets/form/") && req.method === "GET") {
        const token = path.split("/").pop() ?? "";
        const pending = pendingCollections.get(token);
        if (!pending) {
          return addCors(new Response("Invalid or expired form link", { status: 404 }));
        }
        if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
          pendingCollections.delete(token);
          return addCors(new Response("Form link expired", { status: 410 }));
        }
        const reqUrl = new URL(req.url); const baseUrl = resolveBaseUrl(req, reqUrl);
        const html = renderSecretForm(token, pending, baseUrl);
        return addCors(new Response(html, { headers: { "Content-Type": "text/html" } }));
      }

      // POST /secrets/collect - Submit collected secrets and auto-forward to tool
      if (path === "/secrets/collect" && req.method === "POST") {
        const body = (await req.json()) as {
          token: string;
          values: Record<string, string>;
        };

        const pending = pendingCollections.get(body.token);
        if (!pending) {
          return addCors(
            jsonResponse({ error: "Invalid or expired collection token" }, 400),
          );
        }

        // One-time use
        pendingCollections.delete(body.token);

        // Check expiry (10 min)
        if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
          return addCors(
            jsonResponse({ error: "Collection token expired" }, 400),
          );
        }

        // Encrypt secret values and store as refs
        const mergedParams = { ...pending.params };
        for (const [fieldName, value] of Object.entries(body.values)) {
          const fieldDef = pending.fields.find((f) => f.name === fieldName);
          if (fieldDef?.secret && secretStore) {
            // Store encrypted, get ref
            const ownerId = pending.auth?.callerId ?? "anonymous";
            const secretId = await secretStore.store(value, ownerId);
            mergedParams[fieldName] = `secret:${secretId}`;
          } else {
            mergedParams[fieldName] = value;
          }
        }

        // Auto-forward to the target tool
        const callRequest = {
          action: "execute_tool" as const,
          path: pending.agent,
          tool: pending.tool,
          params: mergedParams,
        };

        const toolCtx = {
          tenantId: "default",
          agentPath: pending.agent,
          callerId: pending.auth?.callerId ?? "anonymous",
          callerType: pending.auth?.callerType ?? ("system" as const),
        };

        const result = await registry.call({
          ...callRequest,
          context: toolCtx,
        } as any);

        return addCors(jsonResponse({ success: true, result }));
      }


      // --- Web pages (plain HTML, served from same server) ---
      const htmlRes = (body: string) => addCors(new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
      const reqUrl = new URL(req.url);
      const baseUrl = resolveBaseUrl(req, reqUrl);

      // Auto-register Slack as an integration provider if env vars are set
      const slackConfigured = !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
      if (slackConfigured) {
        try {
          await registry.call({
            action: "execute_tool",
            path: "@integrations",
            tool: "setup_integration",
            params: {
              provider: "slack",
              name: "Slack",
              auth: {
                authUrl: "https://slack.com/openid/connect/authorize",
                tokenUrl: "https://slack.com/api/openid.connect.token",
                scopes: ["openid", "email", "profile"],
                clientAuthMethod: "client_secret_post",
                tokenContentType: "application/x-www-form-urlencoded",
              },
              clientId: process.env.SLACK_CLIENT_ID,
              clientSecret: process.env.SLACK_CLIENT_SECRET,
            },
            context: { tenantId: "default", agentPath: "@integrations", callerId: "system", callerType: "system" },
          } as any);
        } catch (e: any) {
          // Ignore if already set up
          if (!e.message?.includes("already")) console.warn("[auth] Slack provider setup:", e.message);
        }
      }

      // Helper: read session from cookie
      function getSession(r: Request): Record<string, any> | null {
        const c = r.headers.get("Cookie") || "";
        const m = c.match(/s_session=([^;]+)/);
        if (!m) return null;
        try { return JSON.parse(Buffer.from(m[1], "base64url").toString()); }
        catch { return null; }
      }

      // Helper: generate JWT from client credentials
      async function generateMcpToken(): Promise<string> {
        const clientRes = await registry.call({ action: "execute_tool", path: "@auth", tool: "create_client", callerType: "system", params: {
          name: "mcp-" + Date.now(),
          scopes: ["*"],
        }} as any) as any;
        const cid = clientRes?.result?.clientId;
        const csec = clientRes?.result?.clientSecret;
        if (!cid || !csec) throw new Error("Failed to create client: " + JSON.stringify(clientRes));

        const tokenRes = await globalThis.fetch(`http://localhost:${port}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec }),
        });
        const tokenData = await tokenRes.json() as any;
        if (!tokenData.access_token) throw new Error("Failed to get JWT: " + JSON.stringify(tokenData));
        return tokenData.access_token;
      }

      // Helper: set session cookie and redirect
      function sessionRedirect(location: string, session: Record<string, any>): Response {
        const data = Buffer.from(JSON.stringify(session)).toString("base64url");
        return new Response(null, {
          status: 302,
          headers: {
            Location: location,
            "Set-Cookie": `s_session=${data}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
          },
        });
      }

      // GET / — login page (or redirect to dashboard if session exists)
      if (path === "/" && req.method === "GET") {
        const session = getSession(req);
        if (session?.token) return Response.redirect(`${baseUrl}/dashboard`, 302);
        return htmlRes(renderLoginPage(baseUrl, slackConfigured));
      }

      // GET /auth/slack — start Slack OAuth
      if (path === "/auth/slack" && req.method === "GET") {
        if (!slackConfigured) return htmlRes("<h1>Slack OAuth not configured</h1>");
        try {
          const connectResult = await registry.call({
            action: "execute_tool",
            path: "@integrations",
            tool: "connect_integration",
            params: {
              provider: "slack",
              state: btoa(JSON.stringify({ providerId: "slack", type: "auth", redirectUrl: `${baseUrl}/dashboard` })),
            },
            context: { tenantId: "default", agentPath: "@integrations", callerId: "system", callerType: "system" },
          } as any) as any;
          const authUrl = connectResult?.result?.authUrl;
          if (!authUrl) return htmlRes("<h1>Failed to generate Slack OAuth URL</h1>");
          return Response.redirect(authUrl, 302);
        } catch (err: any) {
          console.error("[auth] Slack connect error:", err);
          return htmlRes(`<h1>Slack OAuth Error</h1><p>${err.message}</p>`);
        }
      }

      // GET /setup — tenant creation page
      if (path === "/setup" && req.method === "GET") {
        const session = getSession(req);
        if (!session?.email) return Response.redirect(`${baseUrl}/`, 302);
        return htmlRes(renderTenantPage(baseUrl, session.email, session.name || ""));
      }

      // POST /setup — create tenant + user + link identity + generate token
      if (path === "/setup" && req.method === "POST") {
        try {
          const body = await req.json() as { email?: string; tenant?: string; name?: string };
          const session = getSession(req);
          console.log("[setup] body:", JSON.stringify(body), "session:", JSON.stringify(session));

          // 1. Create tenant
          const tenantRes = await registry.call({ action: "execute_tool", path: "@auth", callerType: "system", tool: "create_tenant", params: { name: body.tenant } } as any) as any;
          const tenantId = tenantRes?.result?.tenantId;
          if (!tenantId) return addCors(jsonResponse({ error: "Failed to create tenant" }, 400));
          console.log("[setup] tenant created:", tenantId);

          // 2. Create user
          const userRes = await registry.call({ action: "execute_tool", path: "@users", callerType: "system", tool: "create_user", params: { email: body.email, name: session?.name, tenantId } } as any) as any;
          const userId = userRes?.result?.id || userRes?.result?.user?.id;
          console.log("[setup] user created:", userId);

          // 2b. Link tenant to Slack team
          if (session?.slackTeamId) {
            try {
              const dbUrl = process.env.DATABASE_URL;
              if (dbUrl) {
                const { default: postgres } = await import("postgres");
                const sql = postgres(dbUrl);
                const id = "ti_" + Math.random().toString(36).slice(2, 14);
                await sql`INSERT INTO tenant_identities (id, tenant_id, provider, provider_org_id, name) VALUES (${id}, ${tenantId}, 'slack', ${session.slackTeamId}, ${session.slackTeamName || ''})`;
                await sql.end();
                console.log("[setup] Created tenant_identity for slack team:", session.slackTeamId);
              }
            } catch (e: any) { console.error("[setup] tenant_identity insert error:", e.message); }
          }

          // 3. Link Slack identity
          if (session?.slackUserId && userId) {
            console.log("[setup] linking slack identity:", session.slackUserId);
            const linkRes = await registry.call({ action: "execute_tool", path: "@users", callerType: "system", tool: "link_identity", params: {
              userId,
              provider: "slack",
              providerUserId: session.slackUserId,
              email: body.email,
              name: session.name,
              metadata:{ slackTeamId: session.slackTeamId, slackTeamName: session.slackTeamName }, callerType: "system" }} as any);
            console.log("[setup] link_identity result:", JSON.stringify(linkRes));
          }

          // 4. Generate MCP token
          const mcpToken = await generateMcpToken();
          console.log("[setup] token generated, length:", mcpToken.length);

          return addCors(jsonResponse({ success: true, result: { tenantId, userId, token: mcpToken } }));
        } catch (err: any) {
          console.error("[setup] error:", err);
          return addCors(jsonResponse({ error: err.message }, 400));
        }
      }

      // POST /logout — clear session
      if (path === "/logout" && req.method === "POST") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${baseUrl}/`,
            "Set-Cookie": "s_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
          },
        });
      }

      // GET /dashboard — show MCP URL and setup instructions
      if (path === "/dashboard" && req.method === "GET") {
        const session = getSession(req);
        let token = session?.token || reqUrl.searchParams.get("token") || "";
        if (!token) return Response.redirect(`${baseUrl}/`, 302);

        // Persist token in cookie
        const sessData = Buffer.from(JSON.stringify({ ...session, token })).toString("base64url");
        return new Response(renderDashboardPage(baseUrl, token, session || undefined), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Set-Cookie": `s_session=${sessData}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
          },
        });
      }

      return addCors(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32601,
              message: `Not found: ${req.method} ${path}`,
            },
          },
          404,
        ),
      );
    } catch (err) {
      console.error("[server] Request error:", err);
      return addCors(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: "Internal error" },
          },
          500,
        ),
      );
    }
  }

  // ──────────────────────────────────────────
  // Server lifecycle
  // ──────────────────────────────────────────

  const server: AgentServer = {
    async start(): Promise<void> {
      if (serverInstance) throw new Error("Server is already running");

      // Load signing keys from store, or generate one
      if (authConfig?.store) {
        const stored = await authConfig.store.getSigningKeys?.() ?? [];
        for (const exported of stored) {
          serverSigningKeys.push(await importSigningKey(exported));
        }
        // Seed trusted issuers from config into store
        for (const issuer of configTrustedIssuers) {
          await authConfig.store.addTrustedIssuer?.(issuer);
        }
      }
      if (serverSigningKeys.length === 0) {
        const key = await generateSigningKey();
        serverSigningKeys.push(key);
        if (authConfig?.store) {
          await authConfig.store.storeSigningKey?.(await exportSigningKey(key));
        }
        console.log(`[auth] Generated ES256 signing key: ${key.kid}`);
      } else {
        console.log(`[auth] Loaded ${serverSigningKeys.length} signing key(s) from store`);
      }

      serverInstance = Bun.serve({ port, hostname, fetch });
      serverUrl = `http://${hostname}:${port}${basePath}`;

      console.log(`Agent server running at ${serverUrl}`);
      console.log("  POST /     - MCP JSON-RPC endpoint");
      console.log("  POST /mcp  - MCP JSON-RPC endpoint (alias)");
      console.log("  GET  /health - Health check");
      if (authConfig) {
        console.log("  POST /oauth/token - OAuth2 token endpoint");
        console.log("  Auth: enabled");
      }
      console.log("  MCP tools: call_agent, list_agents");
      console.log("  GET  /.well-known/jwks.json - JWKS endpoint");
      console.log("  GET  /.well-known/configuration - Discovery");
      const allIssuers = await authConfig?.store?.listTrustedIssuers?.() ?? configTrustedIssuers;
      if (allIssuers.length > 0) {
        console.log(`  Trusted issuers: ${allIssuers.join(", ")}`);
      }
    },

    async stop(): Promise<void> {
      if (serverInstance) {
        serverInstance.stop();
        serverInstance = null;
        serverUrl = null;
      }
    },

    fetch,

    get url(): string | null {
      return serverUrl;
    },
  };

  return server;
}
