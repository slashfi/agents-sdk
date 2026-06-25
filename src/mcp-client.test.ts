import { describe, expect, it, vi } from "bun:test";
import { exchangeCodeForTokens, refreshAccessToken } from "./mcp-client.js";

describe("exchangeCodeForTokens", () => {
  it("uses HTTP Basic auth for client_secret_basic", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ access_token: "at", refresh_token: "rt" }),
    );

    await exchangeCodeForTokens(
      "https://api.x.com/2/oauth2/token",
      {
        code: "auth-code",
        codeVerifier: "verifier",
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://example.com/callback",
        clientAuthMethod: "client_secret_basic",
      },
      fetch,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(String(init.body)).not.toContain("client_secret");
    expect(String(init.body)).not.toContain("client_id");
  });

  it("uses client_secret_post by default", async () => {
    const fetch = vi.fn(async () => Response.json({ access_token: "at" }));

    await exchangeCodeForTokens(
      "https://example.com/token",
      {
        code: "auth-code",
        codeVerifier: "verifier",
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://example.com/callback",
      },
      fetch,
    );

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(String(init.body)).toContain("client_secret=client-secret");
    expect(String(init.body)).toContain("client_id=client-id");
  });
});

describe("refreshAccessToken", () => {
  it("uses HTTP Basic auth for client_secret_basic", async () => {
    const fetch = vi.fn(async () => Response.json({ access_token: "at" }));

    await refreshAccessToken(
      "https://api.x.com/2/oauth2/token",
      {
        refreshToken: "refresh-token",
        clientId: "client-id",
        clientSecret: "client-secret",
        clientAuthMethod: "client_secret_basic",
      },
      fetch,
    );

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(String(init.body)).toBe(
      "grant_type=refresh_token&refresh_token=refresh-token",
    );
  });
});
