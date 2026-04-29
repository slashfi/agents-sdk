/**
 * Tests for the `ref` naming contract introduced in 0.74:
 *
 *   - `name` is the local identifier for every stored ref entry.
 *   - Add paths default `name` to `ref` when omitted.
 *   - `as` is not part of the stored or public ref shape.
 *   - Adding a duplicate `name` is a loud error, not a replace.
 */

import { describe, expect, test } from "bun:test";
import { createAdkTools } from "./adk-tools";
import type { FsStore } from "./agent-definitions/config";
import { createAdk, createAgentRegistry, defineAgent } from "./index";
import type { ToolContext } from "./types";

function createMemoryFs(): FsStore {
  const files = new Map<string, string>();
  return {
    async readFile(path: string) {
      return files.get(path) ?? null;
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
  };
}

/** Read a known-present file and parse it as JSON, with typed assertion. */
async function readJson<T = unknown>(fs: FsStore, path: string): Promise<T> {
  const raw = await fs.readFile(path);
  if (raw === null) {
    throw new Error(`Expected ${path} to exist`);
  }
  return JSON.parse(raw) as T;
}

// ─── RefEntry: name field on write ───────────────────────────────────

describe("ref.add — identifier field", () => {
  test("single-instance case stores explicit `name` equal to `ref`", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.ref.add({
      ref: "test-ref",
      scheme: "mcp",
      url: "http://localhost:12345",
    });

    const parsed = await readJson<{ refs: Array<Record<string, unknown>> }>(
      fs,
      "consumer-config.json",
    );
    expect(parsed.refs).toHaveLength(1);
    expect(parsed.refs[0].ref).toBe("test-ref");
    expect(parsed.refs[0].name).toBe("test-ref");
  });

  test("aliasing case stores both `ref` and `name`", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.ref.add({
      ref: "notion",
      name: "work-notion",
      scheme: "mcp",
      url: "http://localhost:12345",
    });

    const parsed = await readJson<{ refs: Array<Record<string, unknown>> }>(
      fs,
      "consumer-config.json",
    );
    expect(parsed.refs[0].ref).toBe("notion");
    expect(parsed.refs[0].name).toBe("work-notion");
  });

  test("adding a duplicate name rejects instead of replacing", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.ref.add({
      ref: "notion",
      name: "work",
      scheme: "mcp",
      url: "http://localhost:12345",
    });

    await expect(
      adk.ref.add({
        ref: "linear",
        name: "work",
        scheme: "mcp",
        url: "http://localhost:12346",
      }),
    ).rejects.toThrow(/already exists/);

    const parsed = await readJson<{ refs: Array<Record<string, unknown>> }>(
      fs,
      "consumer-config.json",
    );
    expect(parsed.refs).toHaveLength(1);
    expect(parsed.refs[0].ref).toBe("notion");
  });
});

// ─── Lookup compatibility: new `name` field works end-to-end ─────────

describe("ref lookup — name/ref resolution", () => {
  test("entries written with `name` are findable by `name`", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.ref.add({
      ref: "notion",
      name: "work-notion",
      scheme: "mcp",
      url: "http://localhost:12345",
    });

    const entry = await adk.ref.get("work-notion");
    expect(entry).not.toBeNull();
    expect(entry?.ref).toBe("notion");
  });

  test("entries written with `name` return name field when listed", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.ref.add({
      ref: "notion",
      name: "work-notion",
      scheme: "mcp",
      url: "http://localhost:12345",
    });

    const refs = await adk.ref.list();
    expect(refs).toHaveLength(1);
    expect(refs[0]?.name).toBe("work-notion");
  });

  test("entries without `name` normalize to `ref`", async () => {
    const fs = createMemoryFs();
    await fs.writeFile(
      "consumer-config.json",
      JSON.stringify({
        refs: [
          {
            ref: "notion",
            scheme: "mcp",
            url: "http://localhost:12345",
          },
        ],
      }),
    );
    const adk = createAdk(fs);

    const refs = await adk.ref.list();
    expect(refs[0]?.name).toBe("notion");
    expect(await adk.ref.get("notion")).not.toBeNull();
  });
});

// ─── ref.update: name is the only rename field ───────────────────────

describe("ref.update — name handling", () => {
  test("passing `name` in updates sets name", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.ref.add({
      ref: "notion",
      name: "old-alias",
      scheme: "mcp",
      url: "http://localhost:12345",
    });

    const ok = await adk.ref.update("old-alias", { name: "new-alias" });
    expect(ok).toBe(true);

    const parsed = await readJson<{ refs: Array<Record<string, unknown>> }>(
      fs,
      "consumer-config.json",
    );
    expect(parsed.refs[0].name).toBe("new-alias");
    expect(parsed.refs[0].ref).toBe("notion");
  });

  test("renaming to an existing name rejects", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);

    await adk.ref.add({
      ref: "notion",
      name: "first",
      scheme: "mcp",
      url: "http://localhost:12345",
    });
    await adk.ref.add({
      ref: "linear",
      name: "second",
      scheme: "mcp",
      url: "http://localhost:12346",
    });

    await expect(adk.ref.update("first", { name: "second" })).rejects.toThrow(
      /already exists/,
    );
  });
});

// ─── Tool surface: the LLM non-determinism scenario ──────────────────
//
// When an LLM is prompted with "Add a ref called X", its tool-call
// arguments can land on either `{ ref: 'X', … }` or `{ name: 'X', … }`
// depending on sampling. The `add` handler defaults the missing field so
// both paths converge on the same stored `{ ref: 'X', name: 'X' }` entry.

describe("ref tool — add operation defaults ref to name", () => {
  function makeRefTool(adk: ReturnType<typeof createAdk>) {
    const tools = createAdkTools({ resolveScope: () => adk });
    const ref = tools.find((t) => t.name === "ref");
    if (!ref) throw new Error("ref tool not found");
    return ref;
  }

  test("LLM sends only `name` → ref defaults to name, entry is findable", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);
    const refTool = makeRefTool(adk);

    const ctx = {} as ToolContext;
    await refTool.execute(
      {
        operation: "add",
        name: "test-identity-ref",
        scheme: "mcp",
        url: "http://127.0.0.1:33469",
      },
      ctx,
    );

    const parsed = await readJson<{ refs: Array<Record<string, unknown>> }>(
      fs,
      "consumer-config.json",
    );
    expect(parsed.refs).toHaveLength(1);
    expect(parsed.refs[0].ref).toBe("test-identity-ref");
    expect(parsed.refs[0].name).toBe("test-identity-ref");

    const entry = await adk.ref.get("test-identity-ref");
    expect(entry).not.toBeNull();
  });

  test("LLM sends only `ref` → same resulting entry", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);
    const refTool = makeRefTool(adk);

    const ctx = {} as ToolContext;
    await refTool.execute(
      {
        operation: "add",
        ref: "test-identity-ref",
        scheme: "mcp",
        url: "http://127.0.0.1:33469",
      },
      ctx,
    );

    const parsed = await readJson<{ refs: Array<Record<string, unknown>> }>(
      fs,
      "consumer-config.json",
    );
    expect(parsed.refs[0].ref).toBe("test-identity-ref");
    expect(parsed.refs[0].name).toBe("test-identity-ref");
  });

  test("LLM sends `ref` + different `name` → stored as canonical + alias", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);
    const refTool = makeRefTool(adk);

    const ctx = {} as ToolContext;
    await refTool.execute(
      {
        operation: "add",
        ref: "notion",
        name: "work-notion",
        scheme: "mcp",
        url: "http://127.0.0.1:33469",
      },
      ctx,
    );

    const parsed = await readJson<{ refs: Array<Record<string, unknown>> }>(
      fs,
      "consumer-config.json",
    );
    expect(parsed.refs[0].ref).toBe("notion");
    expect(parsed.refs[0].name).toBe("work-notion");

    // The entry is findable by the local identifier (name), not the
    // canonical ref.
    expect(await adk.ref.get("work-notion")).not.toBeNull();
  });

  test("LLM omits both `ref` and `name` → loud error (no silent bad write)", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);
    const refTool = makeRefTool(adk);

    const ctx = {} as ToolContext;
    await expect(
      refTool.execute(
        {
          operation: "add",
          scheme: "mcp",
          url: "http://127.0.0.1:33469",
        },
        ctx,
      ),
    ).rejects.toThrow(/ref|name/);

    // Nothing got written.
    const raw = await fs.readFile("consumer-config.json");
    expect(raw).toBeNull();
  });

  test("invalid add input returns schema details through registry call", async () => {
    const fs = createMemoryFs();
    const adk = createAdk(fs);
    const refTool = makeRefTool(adk);
    const registry = createAgentRegistry();
    registry.register(
      defineAgent({
        path: "@config",
        entrypoint: "Config agent",
        tools: [refTool],
        visibility: "public",
      }),
    );

    const response = await registry.call({
      action: "execute_tool",
      path: "@config",
      tool: "ref",
      params: {
        operation: "add",
        ref: "google-calendar",
      },
    });

    expect(response.success).toBe(false);
    if (response.success) throw new Error("expected invalid input error");
    expect(response.code).toBe("TOOL_INPUT_INVALID");
    expect(response.error).toContain("Invalid ref.add input");
    expect(response.details?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "sourceRegistry",
        }),
      ]),
    );
    expect(response.details?.schema).toMatchObject({
      anyOf: expect.any(Array),
    });
    expect(response.details?.operationSchema).toMatchObject({
      type: "object",
    });
    expect(response.hint).toContain("details.schema");
    expect(response.details).not.toHaveProperty("examples");
    expect(JSON.stringify(response.details?.operationSchema)).toContain(
      "sourceRegistry",
    );
  });
});

describe("ref tool — auth state hook", () => {
  test("passes tool input to getAuthStateContext", async () => {
    const authCalls: Array<{
      name: string;
      opts: { stateContext?: Record<string, unknown> };
    }> = [];
    const adk = {
      ref: {
        auth: async (
          name: string,
          opts: { stateContext?: Record<string, unknown> },
        ) => {
          authCalls.push({ name, opts });
          return { complete: true };
        },
      },
    } as unknown as ReturnType<typeof createAdk>;
    const tools = createAdkTools({
      resolveScope: () => adk,
      hooks: {
        getAuthStateContext: async (input) => ({
          name: input.name,
          ref: input.ref,
        }),
      },
    });
    const refTool = tools.find((t) => t.name === "ref");
    if (!refTool) throw new Error("ref tool not found");

    await refTool.execute(
      {
        operation: "auth",
        ref: "google-gmail",
        name: "work2",
      },
      {} as ToolContext,
    );

    expect(authCalls).toHaveLength(1);
    expect(authCalls[0]?.name).toBe("work2");
    expect(authCalls[0]?.opts.stateContext).toEqual({
      ref: "google-gmail",
      name: "work2",
    });
  });
});
