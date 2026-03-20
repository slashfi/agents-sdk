/**
 * Slack OAuth2 (Sign in with Slack / OpenID Connect)
 *
 * Flow:
 *   GET /auth/slack → redirect to Slack authorize
 *   GET /auth/slack/callback → exchange code, get user identity
 */

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const SLACK_AUTH_URL = "https://slack.com/openid/connect/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/openid.connect.token";
const SLACK_USERINFO_URL = "https://slack.com/api/openid.connect.userInfo";

export function slackAuthUrl(config: SlackOAuthConfig, state?: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
  });
  if (state) params.set("state", state);
  return `${SLACK_AUTH_URL}?${params.toString()}`;
}

export async function exchangeSlackCode(
  code: string,
  config: SlackOAuthConfig,
): Promise<{ access_token: string; id_token?: string }> {
  const res = await fetch(SLACK_TOKEN_URL, {
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
  const data = await res.json() as any;
  if (!data.ok) throw new Error(`Slack token exchange failed: ${data.error}`);
  return data;
}

export interface SlackProfile {
  sub: string;        // Slack user ID
  email: string;
  name: string;
  picture?: string;
  "https://slack.com/team_id"?: string;
  "https://slack.com/team_name"?: string;
}

export async function getSlackProfile(accessToken: string): Promise<SlackProfile> {
  const res = await fetch(SLACK_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json() as any;
  if (!data.ok) throw new Error(`Slack userinfo failed: ${data.error}`);
  return data;
}
