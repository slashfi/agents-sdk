/**
 * Agent Server factory.
 *
 * Assembles Hono app with route modules, manages signing keys and lifecycle.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { SigningKey } from "../jwt.js";
import {
  exportSigningKey,
  generateSigningKey,
  importSigningKey,
} from "../jwt.js";
import { createOIDCSignIn } from "../oidc-signin.js";
import type { AgentRegistry } from "../registry.js";
import { detectAuth, resolveAuth } from "./auth.js";
import { registerDiscoveryRoutes } from "./routes/discovery.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import type {
  AgentServer,
  AgentServerOptions,

  HonoEnv,
  ResolvedAuth,
  ServerContext,
  TrustedIssuer,
} from "./types.js";

export function createAgentServer(
  registry: AgentRegistry,
  options: AgentServerOptions = {},
): AgentServer {
  const {
    port = 3000,
    hostname = "localhost",
    basePath = "",
    serverName = "agents-sdk",
    serverVersion = "1.0.0",
    secretStore,
    oauthIdentityProvider,
  } = options;

  // OIDC sign-in handler
  const oidcSignIn = options.oidcProvider
    ? createOIDCSignIn(options.oidcProvider)
    : null;

  // Signing keys + trusted issuers
  const serverSigningKeys: SigningKey[] = [];
  const configTrustedIssuers: TrustedIssuer[] = (
    options.trustedIssuers ?? []
  ).map((i) => (typeof i === "string" ? { issuer: i, scopes: ["*"] } : i));

  const authConfig = detectAuth(registry);
  let serverInstance: ReturnType<typeof Bun.serve> | null = null;

  // Resolve base URL from request
  function resolveBaseUrl(req: Request): string {
    const url = new URL(req.url);
    const forwarded = req.headers.get("X-Forwarded-Host");
    const proto = req.headers.get("X-Forwarded-Proto") ?? url.protocol.replace(":", "");
    const host = forwarded ?? url.host;
    return `${proto}://${host}`;
  }

  // Auth resolution: custom resolver → JWT/header chain
  async function resolveAuthFn(req: Request): Promise<ResolvedAuth | null> {
    const customAuth = options.resolveAuth
      ? await options.resolveAuth(req)
      : null;
    if (customAuth) return customAuth;

    const jwtAuth = await resolveAuth(req, authConfig, {
      signingKeys: serverSigningKeys,
      trustedIssuers: configTrustedIssuers,
    });
    if (jwtAuth) return jwtAuth;

    // Header-based identity (for proxied requests)
    const actorId = req.headers.get("X-Atlas-Actor-Id");
    const actorType = req.headers.get("X-Atlas-Actor-Type");
    if (actorId) {
      return {
        callerId: actorId,
        callerType: (actorType as any) ?? "agent",
        scopes: ["*"],
        claims: {},
      };
    }
    return null;
  }

  // Server context shared by all route modules
  const ctx: ServerContext = {
    registry,
    options,
    serverSigningKeys,
    resolveBaseUrl,
    resolveAuthFn,
    authConfig,
    secretStore,
  };

  // ── Build Hono app ──
  const app = new OpenAPIHono<HonoEnv>();

  // CORS
  if (options.cors !== false) {
    app.use("/*", cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Atlas-Actor-Id", "X-Atlas-Actor-Type"],
    }));
  }

  // Auth middleware
  app.use("/*", async (c, next) => {
    const auth = await resolveAuthFn(c.req.raw);
    c.set("auth", auth);
    await next();
  });

  // Register routes
  registerMcpRoutes(app, ctx);
  registerOAuthRoutes(app, ctx, {
    oidcSignIn,
    oauthIdentityProvider,
    basePath,
    configTrustedIssuers,
  });
  registerDiscoveryRoutes(app, ctx, {
    oidcSignIn,
    basePath,
  });

  // OpenAPI spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: serverName,
      version: serverVersion,
      description: "MCP-compliant agent server (2025-03-26 spec)",
    },
  });


  // ── Server lifecycle ──
  return {
    url: null as string | null,
    registry,

    async initKeys() {
      if (options.signingKey && serverSigningKeys.length === 0) {
        serverSigningKeys.push(options.signingKey);
      } else if (authConfig?.store && serverSigningKeys.length === 0) {
        const stored = (await authConfig.store.getSigningKeys()) ?? [];
        for (const exported of stored) {
          serverSigningKeys.push(await importSigningKey(exported));
        }
      }
      if (serverSigningKeys.length === 0) {
        const key = await generateSigningKey();
        serverSigningKeys.push(key);
        if (authConfig?.store) {
          await authConfig.store.storeSigningKey(await exportSigningKey(key));
        }
      }
    },

    async start() {
      await this.initKeys();
      serverInstance = Bun.serve({
        port,
        hostname,
        fetch: app.fetch,
      });
      (this as any).url = `http://${hostname}:${port}`;
      console.log(`[agents-sdk] Server listening on http://${hostname}:${port}`);
    },

    async stop() {
      if (serverInstance) {
        serverInstance.stop();
        serverInstance = null;
        (this as any).url = null;
      }
    },

    async fetch(req: Request): Promise<Response> {
      if (basePath && new URL(req.url).pathname.startsWith(basePath)) {
        const url = new URL(req.url);
        url.pathname = url.pathname.slice(basePath.length) || "/";
        req = new Request(url.toString(), req);
      }
      return app.fetch(req);
    },

    async signJwt(claims: Record<string, unknown>): Promise<string> {
      if (serverSigningKeys.length === 0) {
        throw new Error(
          "No signing keys available. Call start() or initKeys() first.",
        );
      }
      const key = serverSigningKeys[0];
      const { signJwtES256 } = await import("../jwt.js");
      return signJwtES256(
        { sub: "system", name: "atlas-os", scopes: ["*"], ...claims } as any,
        key.privateKey,
        key.kid,
        options.serverName ?? "agents-sdk",
        "1h",
      );
    },

    async resolveAuth(req: Request): Promise<ResolvedAuth | null> {
      return resolveAuthFn(req);
    },

    addTrustedIssuer(issuerUrl: string, scopes?: string[]): void {
      const existing = configTrustedIssuers.find((i) => i.issuer === issuerUrl);
      if (!existing) {
        configTrustedIssuers.push({
          issuer: issuerUrl,
          scopes: scopes ?? ["*"],
        });
        console.error(`[agent-server] Added trusted issuer: ${issuerUrl}`);
      }
    },
  };
}
