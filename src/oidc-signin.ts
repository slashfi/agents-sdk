/**
 * OIDC Sign-In Provider
 *
 * Implements the full OIDC authorization code flow for user sign-in.
 * The server acts as an OIDC Relying Party — users authenticate with
 * an external Identity Provider and receive a server-signed JWT.
 *
 * Flow:
 *   GET  /signin/authorize  → 302 redirect to IdP
 *   GET  /signin/callback   → exchange code → fetch userinfo → sign JWT → return
 */

import { type SigningKey, signJwtES256 } from "./jwt.js";

export interface OIDCProviderConfig {
  /** OIDC issuer URL (used for discovery) */
  issuer: string;
  /** OAuth client ID */
  clientId: string;
  /** OAuth client secret */
  clientSecret: string;
  /** Scopes to request (default: ["openid", "email", "profile"]) */
  scopes?: string[];
}

/** Cached OIDC discovery document */
interface OIDCDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

/** In-flight state for pending auth flows */
interface PendingFlow {
  redirectUri: string;
  nonce: string;
  createdAt: number;
}

export interface OIDCSignInHandler {
  /** Handle incoming request — call from server fetch */
  handleRequest(
    req: Request,
    params: {
      baseUrl: string;
      signingKey: SigningKey;
      issuerUrl: string;
    },
  ): Promise<Response | null>;
}

export function createOIDCSignIn(
  config: OIDCProviderConfig,
): OIDCSignInHandler {
  let discoveryCache: OIDCDiscovery | null = null;
  const pendingFlows = new Map<string, PendingFlow>();

  async function fetchDiscovery(): Promise<OIDCDiscovery> {
    if (discoveryCache) return discoveryCache;
    const url = `${config.issuer}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    discoveryCache = (await res.json()) as OIDCDiscovery;
    return discoveryCache;
  }

  function generateState(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return Buffer.from(bytes).toString("base64url");
  }

  return {
    async handleRequest(req, { baseUrl, signingKey, issuerUrl }) {
      const url = new URL(req.url);

      // ── GET /signin/authorize → redirect to IdP ──
      if (url.pathname === "/signin/authorize" && req.method === "GET") {
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        if (!redirectUri) {
          return Response.json(
            {
              error: "invalid_request",
              error_description: "Missing redirect_uri",
            },
            { status: 400 },
          );
        }

        const discovery = await fetchDiscovery();
        const state = generateState();
        const nonce = generateState();

        pendingFlows.set(state, {
          redirectUri,
          nonce,
          createdAt: Date.now(),
        });

        // Clean up stale flows (> 10 min)
        const now = Date.now();
        for (const [k, v] of pendingFlows) {
          if (now - v.createdAt > 600_000) pendingFlows.delete(k);
        }

        const scopes = config.scopes ?? ["openid", "email", "profile"];
        const callbackUrl = `${baseUrl}/signin/callback`;
        const authUrl = new URL(discovery.authorization_endpoint);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", config.clientId);
        authUrl.searchParams.set("redirect_uri", callbackUrl);
        authUrl.searchParams.set("scope", scopes.join(" "));
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("nonce", nonce);

        return Response.redirect(authUrl.toString(), 302);
      }

      // ── GET /signin/callback → exchange code → userinfo → JWT ──
      if (url.pathname === "/signin/callback" && req.method === "GET") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          return Response.json(
            {
              error,
              error_description:
                url.searchParams.get("error_description") ?? "",
            },
            { status: 400 },
          );
        }

        if (!code || !state) {
          return Response.json(
            {
              error: "invalid_request",
              error_description: "Missing code or state",
            },
            { status: 400 },
          );
        }

        const flow = pendingFlows.get(state);
        if (!flow) {
          return Response.json(
            {
              error: "invalid_state",
              error_description: "Unknown or expired state",
            },
            { status: 400 },
          );
        }
        pendingFlows.delete(state);

        const discovery = await fetchDiscovery();
        const callbackUrl = `${baseUrl}/signin/callback`;

        // Exchange code for tokens
        const tokenRes = await fetch(discovery.token_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: callbackUrl,
            client_id: config.clientId,
            client_secret: config.clientSecret,
          }),
        });

        if (!tokenRes.ok) {
          const text = await tokenRes.text();
          return Response.json(
            { error: "token_exchange_failed", error_description: text },
            { status: 502 },
          );
        }

        const tokens = (await tokenRes.json()) as { access_token: string };

        // Fetch userinfo
        const userinfoRes = await fetch(discovery.userinfo_endpoint, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });

        if (!userinfoRes.ok) {
          return Response.json(
            {
              error: "userinfo_failed",
              error_description: `Status ${userinfoRes.status}`,
            },
            { status: 502 },
          );
        }

        const userinfo = (await userinfoRes.json()) as Record<string, unknown>;

        // Sign server JWT with user's identity
        const jwt = await signJwtES256(
          {
            sub: (userinfo.sub as string) ?? "unknown",
            email: userinfo.email as string | undefined,
            name: userinfo.name as string | undefined,
            picture: userinfo.picture as string | undefined,
            provider: "oidc",
            oidc_issuer: config.issuer,
            iss: issuerUrl,
          },
          signingKey.privateKey,
          signingKey.kid,
          issuerUrl,
          "1h",
        );

        // Redirect back to the caller with the JWT
        const sep = flow.redirectUri.includes("?") ? "&" : "?";
        return Response.redirect(`${flow.redirectUri}${sep}token=${jwt}`, 302);
      }

      // Not a signin route
      return null;
    },
  };
}
