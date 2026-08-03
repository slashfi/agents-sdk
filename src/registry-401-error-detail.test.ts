/**
 * Regression: a 401 from a registry must carry a human-readable error.
 *
 * callRegistry used to seed a default { success:false, error:'unauthorized' }
 * and then do parsed = JSON.parse(body), which REPLACED the whole object.
 * When the 401 body was valid JSON without an error key, the default was
 * destroyed and the envelope had no error at all. Callers (call-agent.ts)
 * then fell back to the opaque 'Tool execution failed', hiding the real
 * upstream cause.
 */
import { describe, expect, test } from "bun:test";
import { createRegistryConsumer } from "./registry-consumer";

const URL_ = "https://registry.example.com";

function consumerWith(body: string, status = 401) {
  const fetchFn = (async () =>
    new Response(body, { status })) as unknown as typeof fetch;
  return createRegistryConsumer(
    { registries: [URL_], refs: [{ ref: "slash" }] },
    { fetch: fetchFn },
  );
}

const req = {
  action: "execute_tool" as const,
  path: "slash",
  tool: "list_endpoints",
  params: {},
};

async function callWith(body: string) {
  const consumer = await consumerWith(body);
  return (await consumer.callRegistry(
    { url: URL_, auth: { type: "none" } } as never,
    req,
  )) as Record<string, unknown>;
}

describe("callRegistry 401 error detail", () => {
  test("JSON body with no error key still yields a usable error (regression)", async () => {
    const res = await callWith(JSON.stringify({ result: { tools: [] } }));
    expect(res.success).toBe(false);
    expect(typeof res.error).toBe("string");
    expect((res.error as string).length).toBeGreaterThan(0);
    expect(res.error).not.toBe("Tool execution failed");
  });

  test("preserves an explicit upstream error string", async () => {
    const res = await callWith(JSON.stringify({ error: "invalid_api_key" }));
    expect(res.error).toBe("invalid_api_key");
  });

  test("falls back to message when there is no error", async () => {
    const res = await callWith(JSON.stringify({ message: "API key revoked" }));
    expect(res.error).toBe("API key revoked");
  });

  test("non-JSON body is surfaced as context, not swallowed", async () => {
    const res = await callWith("Unauthorized: bad token");
    expect(res.error as string).toContain("Unauthorized: bad token");
  });

  test("empty body still names the failure and the registry", async () => {
    const res = await callWith("");
    expect(res.error as string).toContain("401");
    expect(res.error as string).toContain(URL_);
  });

  test("always reports httpStatus 401 so ref.call can refresh + retry", async () => {
    const res = await callWith(JSON.stringify({ result: {} }));
    expect(res.httpStatus).toBe(401);
    expect(res.success).toBe(false);
  });
});
