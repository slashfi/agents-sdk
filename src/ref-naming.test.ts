/**
 * Tests for the `ref` naming contract introduced in 0.74:
 *
 *   - `RefEntry` gains an optional `name?` field for the local identifier.
 *     The legacy `as?` field still parses for backward compat.
 *   - `normalizeRef` resolves the identifier as `name ?? as ?? ref`, so
 *     all lookup paths (get, list, update, remove) accept entries written
 *     in either shape.
 *   - `createRefTool` (the adk-tools.ts MCP tool) drops `as` from its
 *     schema and defaults `ref` to `name` on add, so "Add a ref called X"
 *     via an LLM that picks either field lands on the same stored
 *     `{ ref: 'X' }` entry.
 */

import { describe, expect, test } from "bun:test";
import { createAdkTools } from "./adk-tools";
import type { FsStore } from "./agent-definitions/config";
import { createAdk } from "./index";
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
  test("single-instance case stores only `ref` (no `name`/`as`)", async () => {
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
    expect(parsed.refs[0].name).toBeUndefined();
    expect(parsed.refs[0].as).toBeUndefined();
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
    // Legacy `as` field is never emitted on new writes.
    expect(parsed.refs[0].as).toBeUndefined();
  });
});

// ─── Lookup compatibility: new `name` field works end-to-end ─────────

describe("ref lookup — name/as/ref resolution", () => {
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

  test("legacy entries written with `as` remain findable by `as`", async () => {
    // Simulate a consumer-config.json produced by a pre-0.74 client that
    // still writes the `as` field. The read path must still resolve it.
    const fs = createMemoryFs();
    await fs.writeFile(
      "consumer-config.json",
      JSON.stringify({
        refs: [
          {
            ref: "notion",
            as: "work-notion",
            scheme: "mcp",
            url: "http://localhost:12345",
          },
        ],
      }),
    );
    const adk = createAdk(fs);

    const entry = await adk.ref.get("work-notion");
    expect(entry).not.toBeNull();
    expect(entry?.ref).toBe("notion");
    expect(entry?.as).toBe("work-notion");
  });

  test("when both `name` and `as` are present, `name` wins", async () => {
    const fs = createMemoryFs();
    await fs.writeFile(
      "consumer-config.json",
      JSON.stringify({
        refs: [
          {
            ref: "notion",
            name: "new-identifier",
            as: "legacy-identifier",
            scheme: "mcp",
            url: "http://localhost:12345",
          },
        ],
      }),
    );
    const adk = createAdk(fs);

    const byNew = await adk.ref.get("new-identifier");
    expect(byNew).not.toBeNull();
    expect(byNew?.ref).toBe("notion");
  });
});

// ─── ref.update: renaming clears the legacy `as` field ───────────────

describe("ref.update — name/as handling", () => {
  test("passing `name` in updates sets name and clears legacy `as`", async () => {
    const fs = createMemoryFs();
    await fs.writeFile(
      "consumer-config.json",
      JSON.stringify({
        refs: [
          {
            ref: "notion",
            as: "old-alias",
            scheme: "mcp",
            url: "http://localhost:12345",
          },
        ],
      }),
    );
    const adk = createAdk(fs);

    const ok = await adk.ref.update("old-alias", { name: "new-alias" });
    expect(ok).toBe(true);

    const parsed = await readJson<{ refs: Array<Record<string, unknown>> }>(
      fs,
      "consumer-config.json",
    );
    expect(parsed.refs[0].name).toBe("new-alias");
    expect(parsed.refs[0].as).toBeUndefined();
    expect(parsed.refs[0].ref).toBe("notion");
  });

  test("passing only `as` updates the legacy field (pre-0.74 callers)", async () => {
    const fs = createMemoryFs();
    await fs.writeFile(
      "consumer-config.json",
      JSON.stringify({
        refs: [
          {
            ref: "notion",
            as: "first",
            scheme: "mcp",
            url: "http://localhost:12345",
          },
        ],
      }),
    );
    const adk = createAdk(fs);

    const ok = await adk.ref.update("first", { as: "second" });
    expect(ok).toBe(true);

    const parsed = await readJson<{ refs: Array<Record<string, unknown>> }>(
      fs,
      "consumer-config.json",
    );
    expect(parsed.refs[0].as).toBe("second");
  });
});

// ─── Tool surface: the LLM non-determinism scenario ──────────────────
//
// When an LLM is prompted with "Add a ref called X", its tool-call
// arguments can land on either `{ ref: 'X', … }` or `{ name: 'X', … }`
// depending on sampling. Pre-0.74, the former stored `{ ref: 'X' }`
// and the latter stored `{ ref: undefined }` (broken lookup). The
// `add` handler now defaults `ref ??= name` so both paths converge on
// the same stored entry.

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
    // name was not stored because it equals ref (single-instance case)
    expect(parsed.refs[0].name).toBeUndefined();

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
    expect(parsed.refs[0].name).toBeUndefined();
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
});
