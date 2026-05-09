import { describe, expect, test } from "bun:test";
import type { FsStore } from "./agent-definitions/config";
import { createAdk } from "./index";
import { encryptSecret } from "./crypto";

function memFs(initial: Record<string, unknown>): FsStore {
  const files = new Map<string, string>([
    ["consumer-config.json", JSON.stringify(initial)],
  ]);
  return {
    async readFile(p) {
      return files.get(p) ?? null;
    },
    async writeFile(p, c) {
      files.set(p, c);
    },
  };
}

describe("ref.call: encrypted config.headers", () => {
  const KEY = "test-encryption-key-1234567890";

  test("forwards plaintext _headers when encryptionKey decrypts", async () => {
    const encApi = `secret:${await encryptSecret("DD_API_KEY_REAL", KEY)}`;
    const encApp = `secret:${await encryptSecret("DD_APP_KEY_REAL", KEY)}`;

    const captured: Array<{ body: string }> = [];
    const fetchSpy: typeof fetch = async (_url, init) => {
      captured.push({ body: String((init as RequestInit | undefined)?.body) });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const adk = createAdk(
      memFs({
        registries: [{ name: "test", url: "https://example.com" }],
        refs: [{
          ref: "datadog",
          scheme: "registry",
          mode: "api",
          sourceRegistry: { agentPath: "datadog", url: "https://example.com" },
          config: { headers: { "DD-API-KEY": encApi, "DD-APPLICATION-KEY": encApp } },
        }],
      }),
      { fetch: fetchSpy, encryptionKey: KEY },
    );

    await adk.ref.call("datadog", "some_tool", { foo: "bar" });

    expect(captured.length).toBe(1);
    const body = JSON.parse(captured[0].body);
    const params = body.params.arguments.request.params;
    expect(params._headers).toEqual({
      "DD-API-KEY": "DD_API_KEY_REAL",
      "DD-APPLICATION-KEY": "DD_APP_KEY_REAL",
    });
  });

  test("hard-fails when secret: header present but encryptionKey is missing", async () => {
    const encApi = `secret:${await encryptSecret("x", KEY)}`;

    const fetchSpy: typeof fetch = async () =>
      new Response("", { status: 200 });

    const adk = createAdk(
      memFs({
        registries: [{ name: "test", url: "https://example.com" }],
        refs: [{
          ref: "datadog",
          scheme: "registry",
          mode: "api",
          sourceRegistry: { agentPath: "datadog", url: "https://example.com" },
          config: { headers: { "DD-API-KEY": encApi } },
        }],
      }),
      { fetch: fetchSpy /* no encryptionKey */ },
    );

    await expect(
      adk.ref.call("datadog", "some_tool", {}),
    ).rejects.toThrow(/encryption_key_missing|encryptionKey/);
  });

  test("hard-fails when encryptionKey is present but cannot decrypt the value", async () => {
    const encApi = `secret:${await encryptSecret("x", KEY)}`;

    const fetchSpy: typeof fetch = async () =>
      new Response("", { status: 200 });

    const adk = createAdk(
      memFs({
        registries: [{ name: "test", url: "https://example.com" }],
        refs: [{
          ref: "datadog",
          scheme: "registry",
          mode: "api",
          sourceRegistry: { agentPath: "datadog", url: "https://example.com" },
          config: { headers: { "DD-API-KEY": encApi } },
        }],
      }),
      { fetch: fetchSpy, encryptionKey: "a-different-wrong-key" },
    );

    await expect(
      adk.ref.call("datadog", "some_tool", {}),
    ).rejects.toThrow(/encryption_key_mismatch|decrypt/);
  });

  test("plaintext header values are still forwarded as-is", async () => {
    const captured: Array<{ body: string }> = [];
    const fetchSpy: typeof fetch = async (_url, init) => {
      captured.push({ body: String((init as RequestInit | undefined)?.body) });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const adk = createAdk(
      memFs({
        registries: [{ name: "test", url: "https://example.com" }],
        refs: [{
          ref: "weather",
          scheme: "registry",
          mode: "api",
          sourceRegistry: { agentPath: "weather", url: "https://example.com" },
          config: { headers: { "X-API-Key": "plain-value" } },
        }],
      }),
      { fetch: fetchSpy /* no encryptionKey needed for plaintext */ },
    );

    await adk.ref.call("weather", "some_tool", {});

    expect(captured.length).toBe(1);
    const body = JSON.parse(captured[0].body);
    const params = body.params.arguments.request.params;
    expect(params._headers).toEqual({ "X-API-Key": "plain-value" });
  });
});
