/**
 * OAuth2 + OIDC routes.
 *
 * POST /oauth/token → Token exchange (jwt_exchange, client_credentials)
 * GET /oauth/authorize → Identity linking redirect (browser flow)
 * GET /oauth/callback → Identity linking callback
 * GET /signin/authorize → OIDC sign-in
 * GET /signin/callback → OIDC sign-in callback
 */

import type { OpenAPIHono } from "@hono/zod-openapi";
import { jsonResponse } from "../helpers.js";
import {
  signJwtES256,
  verifyJwtFromIssuer,
} from "../../jwt.js";
import type { OIDCSignInHandler } from "../../oidc-signin.js";
import type {
  HonoEnv,
  OAuthIdentityProvider,
  ServerContext,
  TrustedIssuer,
} from "../types.js";

export function registerOAuthRoutes(
  app: OpenAPIHono<HonoEnv>,
  ctx: ServerContext,
  deps: {
    oidcSignIn?: OIDCSignInHandler | null;
    oauthIdentityProvider?: OAuthIdentityProvider;
    basePath: string;
    configTrustedIssuers: TrustedIssuer[];
  },
) {
  const { registry, serverSigningKeys, resolveBaseUrl, authConfig } = ctx;
  const { oidcSignIn, oauthIdentityProvider, basePath, configTrustedIssuers } = deps;

  // ── POST /oauth/token ──
  app.post("/oauth/token", async (c) => {
    return handleOAuthToken(c.req.raw);
  });

  async function handleOAuthToken(req: Request): Promise<Response> {
    if (!authConfig) {
      return jsonResponse({ error: "auth_not_configured" }, 404);
    }

    const contentType = req.headers.get("Content-Type") ?? "";
    let params: Record<string, string>;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const body = await req.text();
      const urlParams = new URLSearchParams(body);
      params = Object.fromEntries(urlParams.entries());
    } else {
      params = (await req.json()) as Record<string, string>;
    }

    const grantType = params.grant_type ?? "";

    // ── jwt_exchange grant: verify foreign JWT, resolve local identity ──
    if (grantType === "jwt_exchange") {
      const assertion = params.assertion ?? "";
      if (!assertion) {
        return jsonResponse(
          {
            error: "invalid_request",
            error_description: "Missing assertion parameter",
          },
          400,
        );
      }

      try {
        const result = await registry.call({
          action: "execute_tool",
          path: "@auth",
          tool: "exchange_token",
          params: { token: assertion },
          callerType: "system",
        });

        const exchangeResult = (result as any)?.result;
        // If the tool call failed, forward the error
        if ((result as any)?.success === false) {
          return jsonResponse(
            {
              error: "server_error",
              error_description:
                (result as any)?.error ?? "Exchange tool failed",
              raw: JSON.stringify(result)?.slice(0, 300),
            },
            500,
          );
        }

        // ── Reverse registration: if caller is an agent-registry, auto-store connection ──
        try {
          const assertionParts = assertion.split(".");
          if (assertionParts.length === 3) {
            const assertionPayload = JSON.parse(
              Buffer.from(assertionParts[1], "base64url").toString(),
            ) as any;
            if (
              assertionPayload.type === "agent-registry" &&
              assertionPayload.iss
            ) {
              // Use add_connection (direct store) instead of setup_integration (which would cause infinite loop)
              const addResult = await registry.call({
                action: "execute_tool",
                path: "@remote-registry",
                tool: "add_connection",
                params: {
                  id: assertionPayload.name ?? "remote-registry",
                  name: assertionPayload.name ?? "remote-registry",
                  url: assertionPayload.iss,
                  remoteTenantId: assertionPayload.tenantId ?? "default",
                },
                callerId: "system",
                callerType: "system",
              });
              if (addResult.success) {
                console.error(
                  `[jwt_exchange] Reverse connection stored for ${assertionPayload.iss}`,
                );
              } else {
                console.error(
                  "[jwt_exchange] Reverse connection failed:",
                  (addResult as any).error,
                );
              }
            }
          }
        } catch (reverseErr) {
          console.error(
            "[jwt_exchange] Reverse registration check failed:",
            reverseErr,
          );
        }

        if (!exchangeResult) {
          return jsonResponse(
            {
              error: "server_error",
              error_description: `Exchange returned null: ${JSON.stringify(result)?.slice(0, 300)}`,
            },
            500,
          );
        }

        // User not linked yet — needs OAuth identity linking
        if (exchangeResult.needsAuth) {
          const baseUrl = resolveBaseUrl(req);
          const authorizeUrl = new URL(`${baseUrl}${basePath}/oauth/authorize`);
          authorizeUrl.searchParams.set("token", assertion);
          if (params.redirect_uri) {
            authorizeUrl.searchParams.set("redirect_uri", params.redirect_uri);
          }
          if (params.scope) {
            authorizeUrl.searchParams.set("scope", params.scope);
          }
          return jsonResponse(
            {
              error: "identity_required",
              error_description:
                "User identity not linked. Redirect to authorize_url to complete linking.",
              authorize_url: authorizeUrl.toString(),
              tenant_id: exchangeResult.tenantId,
            },
            403,
          );
        }

        // User found — sign a local access token
        if (exchangeResult.userId && serverSigningKeys.length > 0) {
          const sigKey = serverSigningKeys[0];
          const token = await signJwtES256(
            {
              sub: exchangeResult.userId,
              name: exchangeResult.userId,
              scopes: ["*"],
              tenantId: exchangeResult.tenantId,
            },
            sigKey.privateKey,
            sigKey.kid,
            resolveBaseUrl(req),
            `${authConfig.tokenTtl ?? 3600}s`,
          );

          return jsonResponse({
            access_token: token,
            token_type: "Bearer",
            expires_in: authConfig.tokenTtl ?? 3600,
            user_id: exchangeResult.userId,
            tenant_id: exchangeResult.tenantId,
          });
        }

        return jsonResponse(exchangeResult);
      } catch (err) {
        console.error("[oauth] JWT exchange error:", err);
        return jsonResponse(
          {
            error: "server_error",
            error_description: `JWT exchange failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          500,
        );
      }
    }

    // ── client_credentials grant ──
    if (grantType === "client_credentials") {
      const clientId = params.client_id ?? "";
      const clientSecret = params.client_secret ?? "";

      if (!clientId || !clientSecret) {
        return jsonResponse(
          {
            error: "invalid_request",
            error_description: "Missing client_id or client_secret",
          },
          400,
        );
      }

      try {
        const result = await registry.call({
          action: "execute_tool",
          path: "@auth",
          tool: "token",
          params: { clientId, clientSecret },
          callerType: "system",
        });

        const tokenResult = (result as any)?.result;
        if (!tokenResult?.accessToken) {
          return jsonResponse(
            {
              error: "invalid_client",
              error_description: "Authentication failed",
            },
            401,
          );
        }

        return jsonResponse({
          access_token: tokenResult.accessToken,
          token_type: "Bearer",
          expires_in: tokenResult.expiresIn ?? authConfig.tokenTtl,
          refresh_token: tokenResult.refreshToken,
        });
      } catch (err) {
        console.error("[oauth] Token error:", err);
        return jsonResponse(
          { error: "server_error", error_description: "Token exchange failed" },
          500,
        );
      }
    }

    return jsonResponse(
      {
        error: "unsupported_grant_type",
        error_description:
          "Supported grant types: client_credentials, jwt_exchange",
      },
      400,
    );
  }

  // ── OIDC Sign-In ──
  if (oidcSignIn) {
    const handleSignIn = async (c: any) => {
      const req = c.req.raw;
      const baseUrl = resolveBaseUrl(req);
      return oidcSignIn.handleRequest(req, {
        baseUrl: baseUrl + basePath,
        signingKey: serverSigningKeys[0],
        issuerUrl: baseUrl,
      });
    };
    app.get("/signin/authorize", handleSignIn as any);
    app.get("/signin/callback", handleSignIn as any);
  }


  // ── GET /oauth/authorize ──
  app.get("/oauth/authorize", async (c) => {
    const req = c.req.raw;
    if (!oauthIdentityProvider) {
      return c.json(
        { error: "not_configured", error_description: "No OAuth identity provider configured" },
        404,
      );
    }
    const url = new URL(req.url);
    const token = url.searchParams.get("token") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";

    if (!token) {
      return c.json(
        { error: "invalid_request", error_description: "Missing token parameter" },
        400,
      );
    }

    // Verify JWT against trusted issuers
    let claims: Record<string, unknown> | null = null;
    const storeIssuers = authConfig?.store
      ? await authConfig.store.listTrustedIssuers()
      : [];
    const configIssuerUrls = configTrustedIssuers.map((i) =>
      typeof i === "string" ? i : i.issuer,
    );
    const allIssuerUrls = [
      ...new Set([...storeIssuers, ...configIssuerUrls]),
    ];
    for (const issuerUrl of allIssuerUrls) {
      try {
        const result = await verifyJwtFromIssuer(token, issuerUrl);
        if (result) {
          claims = result as unknown as Record<string, unknown>;
          break;
        }
      } catch {}
    }
    if (!claims) {
      return c.json(
        { error: "invalid_token", error_description: "JWT verification failed against all trusted issuers" },
        401,
      );
    }

    const baseUrl = resolveBaseUrl(req);
    const scope = url.searchParams.get("scope") ?? undefined;
    return oauthIdentityProvider.authorize(req, {
      token,
      claims,
      redirectUri,
      baseUrl: baseUrl + basePath,
      scope,
    });
  });

  // ── GET /oauth/callback ──
  if (oauthIdentityProvider) {
    app.get("/oauth/callback", async (c) => {
      const req = c.req.raw;
      const baseUrl = resolveBaseUrl(req);
      return oauthIdentityProvider.callback(req, {
        baseUrl: baseUrl + basePath,
      });
    });
  }
}
