import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PersistedSearchIndex,
  buildSearchIndex,
  readSearchIndex,
  searchIndexPath,
  searchRefs,
  writeSearchIndex,
} from "./search";

/**
 * Build a tiny on-disk fixture mimicking what `adk sync` would produce.
 * Returns the `configDir` (root) and `refs/` root for `searchRefs`.
 */
function buildFixture(): {
  configDir: string;
  refsRoot: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "adk-search-"));
  const refsRoot = join(root, "refs");
  mkdirSync(refsRoot, { recursive: true });

  const writeRef = (
    relPath: string,
    manifest: Record<string, unknown>,
    entrypoint: string,
    tools: Array<{ name: string; description: string; params?: string[] }>,
    skills: Array<{ name: string; body: string }> = [],
  ) => {
    const refDir = join(refsRoot, relPath);
    mkdirSync(refDir, { recursive: true });
    writeFileSync(
      join(refDir, "agent.json"),
      JSON.stringify({ ...manifest, toolCount: tools.length }, null, 2),
    );
    writeFileSync(join(refDir, "entrypoint.md"), entrypoint);
    if (tools.length > 0) {
      const toolsDir = join(refDir, "tools");
      mkdirSync(toolsDir, { recursive: true });
      for (const tool of tools) {
        const safe = tool.name.replace(/[^a-zA-Z0-9_-]/g, "-");
        writeFileSync(
          join(toolsDir, `${safe}.tool.md`),
          `# ${tool.name}\n\n${tool.description}\n`,
        );
        const properties: Record<string, { description: string }> = {};
        for (const p of tool.params ?? []) {
          properties[p] = { description: `${p} parameter` };
        }
        writeFileSync(
          join(toolsDir, `${safe}.tool.json`),
          JSON.stringify(
            {
              name: tool.name,
              description: tool.description,
              inputSchema: { type: "object", properties },
            },
            null,
            2,
          ),
        );
      }
    }
    if (skills.length > 0) {
      const skillsDir = join(refDir, "skills");
      mkdirSync(skillsDir, { recursive: true });
      for (const skill of skills) {
        writeFileSync(join(skillsDir, skill.name), skill.body);
      }
    }
  };

  // Integration ref: notion (with a synced skill resource)
  writeRef(
    "notion",
    {
      name: "notion",
      description:
        "Interact with the Notion API — search, create, update pages and databases.",
    },
    "Notion entrypoint with database details and page editing examples.",
    [
      {
        name: "notion-search",
        description: "Search Notion pages and databases by query string.",
        params: ["query", "filter"],
      },
      {
        name: "notion-fetch",
        description: "Fetch a Notion page by ID and return blocks.",
        params: ["pageId"],
      },
    ],
    [
      {
        name: "writing-pages.md",
        body: "# Writing Notion Pages\n\nBest practices for structuring page hierarchies and using callout blocks.\n",
      },
    ],
  );

  // Integration ref: google-calendar
  writeRef(
    "google-calendar",
    {
      name: "google-calendar",
      description:
        "View and manage Google Calendar events, calendars, and availability.",
    },
    "Google Calendar lets you list, create, and update events.",
    [
      {
        name: "list_events",
        description:
          "List events in a calendar within a time window. Supports calendar ID and timezone filters.",
        params: ["calendar_id", "time_min", "time_max"],
      },
      {
        name: "create_event",
        description: "Create a new event with title, start, and end.",
        params: ["calendar_id", "summary", "start", "end"],
      },
    ],
  );

  // Platform agent: /agents/@clock — nested under refs/agents/@clock
  writeRef(
    "agents/@clock",
    {
      name: "/agents/@clock",
      description:
        "Time-based scheduling: timers, intervals, and current time queries.",
    },
    "Clock agent for scheduling reminders and time queries.",
    [
      {
        name: "timer",
        description:
          "Schedule a one-shot reminder that fires at a specified time.",
        params: ["fire_at", "payload"],
      },
      {
        name: "time",
        description: "Get the current time in a specified timezone.",
        params: ["timezone"],
      },
    ],
  );

  return {
    configDir: root,
    refsRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("adk search", () => {
  let fixture: { configDir: string; refsRoot: string; cleanup: () => void };
  beforeEach(() => {
    fixture = buildFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  test("tool name match ranks the right tool first", () => {
    const results = searchRefs(fixture.refsRoot, "notion-search", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.kind).toBe("tool");
    if (top.kind === "tool") {
      expect(top.tool).toBe("notion-search");
      expect(top.ref).toBe("notion");
    }
  });

  test("description-only query finds the right tool", () => {
    const results = searchRefs(fixture.refsRoot, "schedule reminder timer", {
      limit: 5,
    });
    const tools = results.filter((r) => r.kind === "tool");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]).toMatchObject({ ref: "/agents/@clock", tool: "timer" });
  });

  test("--ref restricts results to one ref (bare name)", () => {
    const results = searchRefs(fixture.refsRoot, "search create update", {
      ref: "notion",
      limit: 10,
    });
    for (const r of results) {
      expect(r.ref).toBe("notion");
    }
  });

  test("--ref accepts platform-agent path or shorthand", () => {
    const fullPath = searchRefs(fixture.refsRoot, "timer", {
      ref: "/agents/@clock",
      limit: 5,
    });
    const shorthand = searchRefs(fixture.refsRoot, "timer", {
      ref: "@clock",
      limit: 5,
    });
    expect(fullPath.length).toBeGreaterThan(0);
    expect(shorthand.length).toBeGreaterThan(0);
    for (const r of [...fullPath, ...shorthand]) {
      expect(r.ref).toBe("/agents/@clock");
    }
  });

  test("--tools-only excludes ref-level results", () => {
    const results = searchRefs(fixture.refsRoot, "notion", {
      toolsOnly: true,
      limit: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.kind).toBe("tool");
    }
  });

  test("--refs-only excludes tool-level results", () => {
    const results = searchRefs(fixture.refsRoot, "notion", {
      refsOnly: true,
      limit: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.kind).toBe("ref");
    }
  });

  test("tool result includes docs path, schema path, and call snippet", () => {
    const results = searchRefs(fixture.refsRoot, "list events", { limit: 3 });
    const tool = results.find((r) => r.kind === "tool");
    expect(tool).toBeDefined();
    if (tool && tool.kind === "tool") {
      expect(tool.docs).toContain("google-calendar/tools/");
      expect(tool.docs.endsWith(".tool.md")).toBe(true);
      expect(tool.schema.endsWith(".tool.json")).toBe(true);
      expect(tool.call).toBe(
        `adk ref call google-calendar ${tool.tool} '{...}'`,
      );
    }
  });

  test("parameter names contribute to the index", () => {
    // 'fire_at' is a parameter of the @clock.timer tool.
    const results = searchRefs(fixture.refsRoot, "fire_at", { limit: 5 });
    const top = results.find((r) => r.kind === "tool");
    expect(top).toBeDefined();
    if (top && top.kind === "tool") {
      expect(top.ref).toBe("/agents/@clock");
      expect(top.tool).toBe("timer");
    }
  });

  test("empty results when no docs match", () => {
    const results = searchRefs(
      fixture.refsRoot,
      "xxxxxxxxxxxxxxxxxxx-no-match",
      { limit: 5 },
    );
    expect(results).toEqual([]);
  });

  test("skill resources are indexed and surface as resource results", () => {
    // The notion fixture has skills/writing-pages.md describing
    // page hierarchies and callout blocks.
    const results = searchRefs(fixture.refsRoot, "callout blocks hierarchy", {
      limit: 10,
    });
    const resource = results.find((r) => r.kind === "resource");
    expect(resource).toBeDefined();
    if (resource && resource.kind === "resource") {
      expect(resource.ref).toBe("notion");
      expect(resource.resource).toBe("writing-pages.md");
      expect(resource.docs).toContain("notion/skills/writing-pages.md");
    }
  });

  test("--refs-only and --tools-only both exclude resource results", () => {
    const refsOnly = searchRefs(fixture.refsRoot, "callout blocks", {
      refsOnly: true,
      limit: 10,
    });
    const toolsOnly = searchRefs(fixture.refsRoot, "callout blocks", {
      toolsOnly: true,
      limit: 10,
    });
    for (const r of [...refsOnly, ...toolsOnly]) {
      expect(r.kind).not.toBe("resource");
    }
  });

  test("writeSearchIndex persists a JSON file with docs + items", () => {
    const { path, documentCount } = writeSearchIndex(fixture.configDir);
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(searchIndexPath(fixture.configDir));
    // Dot-prefixed so coding agents skip it.
    expect(path.endsWith("/.search-index.json")).toBe(true);
    expect(documentCount).toBeGreaterThan(0);

    const raw = JSON.parse(readFileSync(path, "utf-8")) as PersistedSearchIndex;
    expect(raw.version).toBe(1);
    expect(Array.isArray(raw.docs)).toBe(true);
    expect(raw.docs.length).toBe(documentCount);
    // Every doc id should have a matching item entry.
    for (const doc of raw.docs) {
      expect(raw.items[doc.id]).toBeDefined();
    }
    // At least one of each kind should be present.
    const kinds = new Set(Object.values(raw.items).map((i) => i.kind));
    expect(kinds.has("ref")).toBe(true);
    expect(kinds.has("tool")).toBe(true);
    expect(kinds.has("resource")).toBe(true);
  });

  test("searchRefs uses the persisted index when present", () => {
    writeSearchIndex(fixture.configDir);
    // Drop a stub doc into the persisted index so we can prove the
    // search path read it instead of walking the filesystem.
    const persisted = readSearchIndex(fixture.configDir);
    expect(persisted).not.toBeNull();
    if (!persisted) return;
    const stubId = "tool:stub-ref|stub-only-tool";
    persisted.docs.push({
      id: stubId,
      text: "stub-only-tool stub-ref unique-marker xyzzy",
    });
    persisted.items[stubId] = {
      kind: "tool",
      ref: "stub-ref",
      tool: "stub-only-tool",
      summary: "Stub tool that only exists in the persisted index.",
      docs: "/persisted/stub.tool.md",
      schema: "/persisted/stub.tool.json",
      call: "adk ref call stub-ref stub-only-tool '{...}'",
    };
    writeFileSync(
      searchIndexPath(fixture.configDir),
      JSON.stringify(persisted, null, 2),
    );

    const results = searchRefs(fixture.refsRoot, "xyzzy unique-marker", {
      limit: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    const stub = results.find(
      (r) => r.kind === "tool" && r.tool === "stub-only-tool",
    );
    expect(stub).toBeDefined();
    // And the stub doesn't exist on disk under refs/, proving the
    // search read from the persisted index, not the filesystem.
    expect(existsSync(join(fixture.refsRoot, "stub-ref"))).toBe(false);
  });

  test("searchRefs falls back to fresh walk when persisted file is missing", () => {
    expect(existsSync(searchIndexPath(fixture.configDir))).toBe(false);
    const results = searchRefs(fixture.refsRoot, "notion-search", {
      limit: 3,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].kind).toBe("tool");
  });

  test("buildSearchIndex returns docs + items consistent with each other", () => {
    const index = buildSearchIndex(fixture.refsRoot);
    expect(index.version).toBe(1);
    expect(index.docs.length).toBeGreaterThan(0);
    for (const doc of index.docs) {
      const item = index.items[doc.id];
      expect(item).toBeDefined();
      // Id encodes the kind.
      const expectedKind = doc.id.startsWith("ref:")
        ? "ref"
        : doc.id.startsWith("tool:")
          ? "tool"
          : "resource";
      expect(item.kind).toBe(expectedKind);
    }
  });

  test("readSearchIndex returns null for missing or version-mismatched files", () => {
    expect(readSearchIndex(fixture.configDir)).toBeNull();
    // Write a bad-version file and confirm we ignore it.
    mkdirSync(fixture.configDir, { recursive: true });
    writeFileSync(
      searchIndexPath(fixture.configDir),
      JSON.stringify({ version: 99, docs: [], items: {} }),
    );
    expect(readSearchIndex(fixture.configDir)).toBeNull();
  });
});
