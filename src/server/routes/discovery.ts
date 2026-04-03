/**
 * Discovery + well-known routes.
 *
 * GET /health → Health check
 * GET /.well-known/jwks.json → JWKS public keys
 * GET /.well-known/configuration → Server discovery (deprecated)
 * GET /.well-known/oauth-authorization-server → OAuth Server Metadata (RFC 8414)
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { buildJwks } from "../../jwt.js";
import type { OIDCSignInHandler } from "../../oidc-signin.js";
import type { HonoEnv, ServerContext } from "../types.js";

export function registerDiscoveryRoutes(
  app: OpenAPIHono<HonoEnv>,
  ctx: ServerContext,
  deps: {
    oidcSignIn?: OIDCSignInHandler | null;
    basePath: string;
  },
) {
  const { options, serverSigningKeys, resolveBaseUrl } = ctx;
  const { oidcSignIn } = deps;

  // Route schemas
  const healthRoute = createRoute({
    method: "get",
    path: "/health",
    tags: ["System"],
    summary: "Health check",
    responses: {
      200: {
        description: "Server status and registered agents",
        content: {
          "application/json": {
            schema: z.object({
              status: z.string().openapi({ example: "ok" }),
              agents: z.array(z.string()).openapi({ example: ["@auth", "notion"] }),
            }),
          },
        },
      },
    },
  });

  const jwksRoute = createRoute({
    method: "get",
    path: "/.well-known/jwks.json",
    tags: ["Auth"],
    summary: "JWKS public keys",
    responses: {
      200: {
        description: "JSON Web Key Set",
        content: { "application/json": { schema: z.object({ keys: z.array(z.record(z.unknown())) }) } },
      },
    },
  });

  const oauthMetadataRoute = createRoute({
    method: "get",
    path: "/.well-known/oauth-authorization-server",
    tags: ["Auth"],
    summary: "OAuth Server Metadata (RFC 8414)",
    responses: {
      200: {
        description: "OAuth authorization server metadata",
        content: {
          "application/json": {
            schema: z.object({
              issuer: z.string(),
              authorization_endpoint: z.string(),
              token_endpoint: z.string(),
              jwks_uri: z.string(),
              response_types_supported: z.array(z.string()),
              grant_types_supported: z.array(z.string()),
              code_challenge_methods_supported: z.array(z.string()),
              token_endpoint_auth_methods_supported: z.array(z.string()),
              registration_endpoint: z.string().optional(),
            }),
          },
        },
      },
    },
  });

  // GET /health
  app.openapi(healthRoute, (c) => {
    return c.json({ status: "ok" as const, agents: ctx.registry.listPaths() });
  });

  // GET /.well-known/jwks.json
  app.openapi(jwksRoute, async (c) => {
    const jwks =
      serverSigningKeys.length > 0
        ? await buildJwks(serverSigningKeys)
        : { keys: [] };
    return c.json(jwks);
  });

  // GET /.well-known/configuration (deprecated)
  app.get("/.well-known/configuration", (c) => {
    const baseUrl = resolveBaseUrl(c.req.raw);
    return c.json({
      issuer: baseUrl,
      jwks_uri: `${baseUrl}/.well-known/jwks.json`,
      token_endpoint: `${baseUrl}/oauth/token`,
      call_endpoint: baseUrl,
      supported_grant_types: ["client_credentials", "jwt_exchange"],
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      ...(oidcSignIn
        ? { signin_endpoint: `${baseUrl}/signin/authorize` }
        : {}),
    });
  });

  // GET /.well-known/oauth-authorization-server (RFC 8414)
  app.openapi(oauthMetadataRoute, (c) => {
    if (
      !options.registry?.oauthCallbackUrl &&
      serverSigningKeys.length === 0
    ) {
      return c.notFound() as any;
    }

    const baseUrl = resolveBaseUrl(c.req.raw);
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      jwks_uri: `${baseUrl}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "client_credentials",
        "jwt_exchange",
      ],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      ...(options.registry?.oauthCallbackUrl && {
        registration_endpoint: `${baseUrl}/oauth/register`,
      }),
    });
  });
}
