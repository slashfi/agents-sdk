/**
 * Google OAuth2 helpers for the web login flow.
 *
 * Flow:
 *   GET /auth/google → redirect to Google consent screen
 *   GET /auth/google/callback → exchange code, get profile, create/find user
 */

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Full callback URL, e.g. https://registry.slash.com/auth/google/callback */
  redirectUri: string;
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/** Build the Google OAuth authorization URL */
export function googleAuthUrl(config: GoogleOAuthConfig, state?: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
  });
  if (state) params.set("state", state);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Exchange authorization code for tokens */
export async function exchangeGoogleCode(
  code: string,
  config: GoogleOAuthConfig,
): Promise<{ access_token: string; id_token?: string; refresh_token?: string }> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }
  return res.json() as any;
}

/** Get user profile from Google */
export async function getGoogleProfile(
  accessToken: string,
): Promise<{ email: string; name: string; picture?: string }> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Failed to fetch Google profile");
  return res.json() as any;
}
