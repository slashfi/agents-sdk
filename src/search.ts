/**
 * adk search — BM25 over materialized ref/tool docs.
 *
 * Walks `${configDir}/refs/` and indexes every ref + tool + skill found:
 *
 *   `<configDir>/refs/<ref>/agent.json`           → ref-level fields
 *   `<configDir>/refs/<ref>/entrypoint.md`        → ref-level body
 *   `<configDir>/refs/<ref>/tools/<t>.tool.md`    → per-tool body
 *   `<configDir>/refs/<ref>/tools/<t>.tool.json`  → per-tool param names/descs
 *   `<configDir>/refs/<ref>/resources/<file>`     → per-resource body
 *   `<configDir>/refs/<ref>/skills/<file>`        → legacy resource mirror
 *
 * Platform agents nest under `refs/agents/<@name>/`; integration refs sit
 * directly at `refs/<name>/`. The walker handles both layouts.
 *
 * One BM25 document per ref + one per tool + one per skill resource. Tool
 * and ref names get inserted multiple times into the document text so they
 * outweigh surrounding prose without the BM25 implementation needing
 * per-field weighting.
 *
 * Persistence: `adk sync` calls `writeSearchIndex(configDir)` to dump the
 * raw BM25 docs + per-doc result metadata to `<configDir>/.search-index.json`.
 * `searchRefs` prefers that file when it exists — `adk search` becomes a
 * single file read + BM25 build (a few ms) instead of a recursive walk.
 * Falls back to a fresh walk when the persisted file is missing or stale.
 *
 * The file is dot-prefixed so coding agents treat it as a hidden artifact
 * and don't try to read it directly — they should use `adk search` instead.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { createBM25Index } from "./bm25.js";

// ============================================
// Types
// ============================================

export interface SearchOptions {
  /** Max results returned. */
  limit?: number;
  /**
   * Restrict to one ref by name. Matches both bare names (`notion`) and
   * platform-agent paths (`/agents/@clock`). Filtering happens after
   * scoring, so other refs' content doesn't affect the ranking of
   * the kept ref's documents.
   */
  ref?: string;
  /** Only include per-tool results. */
  toolsOnly?: boolean;
  /** Only include ref-level results. */
  refsOnly?: boolean;
}

export type SearchResult =
  | {
      kind: "tool";
      /** Canonical ref name (e.g. `notion`, `/agents/@clock`). */
      ref: string;
      /** Tool name. */
      tool: string;
      score: number;
      /** First non-blank line of the tool's .tool.md (description). */
      summary: string;
      /** Path to the per-tool .tool.md. */
      docs: string;
      /** Path to the per-tool .tool.json. */
      schema: string;
      /** Suggested CLI snippet. */
      call: string;
    }
  | {
      kind: "ref";
      /** Canonical ref name. */
      ref: string;
      score: number;
      /** Description from agent.json. */
      summary: string;
      /** Ref directory path. */
      docs: string;
      /** Path to entrypoint.md. */
      entrypoint: string;
      /** Number of tools the ref exposes. */
      toolCount: number;
    }
  | {
      kind: "resource";
      /** Canonical ref name that owns this resource. */
      ref: string;
      /** Resource name (file basename, e.g. `writing-pages.md`). */
      resource: string;
      score: number;
      /** First non-blank, non-heading line of the resource. */
      summary: string;
      /** Absolute or `~`-rooted path to the resource file. */
      docs: string;
    };

// ============================================
// Persisted index format
// ============================================

/** Per-document metadata we need to render a SearchResult — score is added at search time. */
type IndexItem =
  | {
      kind: "ref";
      ref: string;
      summary: string;
      docs: string;
      entrypoint: string;
      toolCount: number;
    }
  | {
      kind: "tool";
      ref: string;
      tool: string;
      summary: string;
      docs: string;
      schema: string;
      call: string;
    }
  | {
      kind: "resource";
      ref: string;
      resource: string;
      summary: string;
      docs: string;
    };

/**
 * Serialized BM25 index. Written by `writeSearchIndex` (called from
 * `adk sync`) and read by `searchRefs` to skip the recursive filesystem
 * walk on every query.
 *
 * `docs` feeds `createBM25Index` directly. `items` is keyed by the same
 * `id` so we can map ranked hits back to renderable result objects.
 */
export interface PersistedSearchIndex {
  /** Bumped on incompatible changes. Older readers must rebuild. */
  version: 1;
  generatedAt: string;
  /** BM25 input documents. */
  docs: { id: string; text: string }[];
  /** Per-id metadata used to render `SearchResult`. */
  items: Record<string, IndexItem>;
}

const INDEX_VERSION = 1 as const;
/**
 * Sibling to `refs/` and `adk.d.ts` in the config directory. Dot-prefixed
 * so coding agents treat it as a hidden artifact rather than something
 * they should read directly — agents should query through `adk search`.
 */
export const SEARCH_INDEX_FILENAME = ".search-index.json";

// ============================================
// Index building (filesystem walk)
// ============================================

/**
 * Walk `refsRoot` recursively. Every directory containing an `agent.json`
 * is a materialized ref. Builds the unified BM25 docs + per-result metadata
 * map used by both the live search path and the persisted index writer.
 *
 * Ids embed the kind so that `adk search`'s kind filters can apply post-rank
 * without re-running BM25:
 *
 *   `ref:<refName>`
 *   `tool:<refName>|<toolName>`
 *   `resource:<refName>|<fileName>`
 *
 * The `|` separator is safe because ref / tool / resource names use
 * letters / numbers / `-` / `_` / `/` / `@` / `.` only.
 */
export function buildSearchIndex(refsRoot: string): PersistedSearchIndex {
  const docs: { id: string; text: string }[] = [];
  const items: Record<string, IndexItem> = {};

  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    const agentJsonPath = join(dir, "agent.json");
    if (existsSync(agentJsonPath)) {
      try {
        const manifest = JSON.parse(readFileSync(agentJsonPath, "utf-8")) as {
          name?: string;
          description?: string;
          tools?: string[];
          toolCount?: number;
        };
        const refName = manifest.name ?? basename(dir);
        const description = manifest.description ?? "";
        const toolCount = manifest.toolCount ?? manifest.tools?.length ?? 0;
        const entrypointPath = join(dir, "entrypoint.md");
        const entrypointBody = existsSync(entrypointPath)
          ? readFileSync(entrypointPath, "utf-8")
          : "";

        const refId = `ref:${refName}`;
        docs.push({
          id: refId,
          text: [refName, refName, description, entrypointBody].join(" \n "),
        });
        items[refId] = {
          kind: "ref",
          ref: refName,
          summary: description || refName,
          docs: dir,
          entrypoint: entrypointPath,
          toolCount,
        };

        const toolsDir = join(dir, "tools");
        if (existsSync(toolsDir)) {
          for (const file of readdirSync(toolsDir)) {
            if (!file.endsWith(".tool.md")) continue;
            const toolMdPath = join(toolsDir, file);
            const toolJsonPath = toolMdPath.replace(
              /\.tool\.md$/,
              ".tool.json",
            );
            const md = readFileSync(toolMdPath, "utf-8");
            const summary = firstNonBlankLine(md, refName, file);
            const tool = parseToolName(toolJsonPath, file);
            const paramText = extractParamText(toolJsonPath);
            // Repeat the high-signal terms (ref + tool name) so BM25
            // ranks exact-name matches above ambient body matches.
            const text = [
              tool,
              tool,
              tool,
              refName,
              refName,
              md,
              paramText,
            ].join(" \n ");
            const id = `tool:${refName}|${tool}`;
            docs.push({ id, text });
            items[id] = {
              kind: "tool",
              ref: refName,
              tool,
              summary,
              docs: toolMdPath,
              schema: toolJsonPath,
              call: `adk ref call ${refName} ${tool} '{...}'`,
            };
          }
        }

        // Skills / resources written by `materializeRef` — text content
        // synced from the registry's `read_resources` / `list_resources`
        // surface. Indexed so `adk search` can surface ref-specific
        // skill files (e.g. "writing pages" → notion's writing-pages.md).
        // Prefer the MCP-native `resources/` directory; fall back to the
        // legacy `skills/` mirror for indexes generated by older SDKs.
        const indexResourceDir = (root: string) => {
          const visit = (current: string) => {
            for (const entry of readdirSync(current)) {
              const path = join(current, entry);
              let stat;
              try {
                stat = statSync(path);
              } catch {
                continue;
              }
              if (stat.isDirectory()) {
                visit(path);
                continue;
              }
              if (!stat.isFile()) continue;

              let body: string;
              try {
                body = readFileSync(path, "utf-8");
              } catch {
                continue;
              }
              const resource = relative(root, path).replace(/\\/g, "/");
              const summary = firstNonBlankLine(body, refName, resource);
              const text = [resource, resource, refName, refName, body].join(" \n ");
              const id = `resource:${refName}|${resource}`;
              docs.push({ id, text });
              items[id] = {
                kind: "resource",
                ref: refName,
                resource,
                summary,
                docs: path,
              };
            }
          };
          if (existsSync(root)) visit(root);
        };

        const resourcesDir = join(dir, "resources");
        if (existsSync(resourcesDir)) {
          indexResourceDir(resourcesDir);
        } else {
          const skillsDir = join(dir, "skills");
          if (existsSync(skillsDir)) indexResourceDir(skillsDir);
        }
      } catch {
        // Malformed agent.json — skip this directory but keep walking.
      }
    }

    // Recurse into subdirectories that aren't tool / skill / types output —
    // those have no nested agents. Anything else (e.g. `agents/`) might
    // hold platform-agent refs.
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (
        entry === "tools" ||
        entry === "resources" ||
        entry === "skills" ||
        entry === "types"
      )
        continue;
      walk(full);
    }
  }

  walk(refsRoot);
  return {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    docs,
    items,
  };
}

// ============================================
// Persistence
// ============================================

/** Resolve the persisted-index path for a given config directory. */
export function searchIndexPath(configDir: string): string {
  return join(configDir, SEARCH_INDEX_FILENAME);
}

/**
 * Build and write the persisted index to `<configDir>/.search-index.json`.
 * Called from `adk sync` so subsequent `adk search` invocations skip the
 * recursive ref walk.
 */
export function writeSearchIndex(configDir: string): {
  path: string;
  documentCount: number;
} {
  const refsRoot = join(configDir, "refs");
  const index = buildSearchIndex(refsRoot);
  const path = searchIndexPath(configDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Pretty-print in dev only; production indexes will be small enough
  // that minified output isn't worth the readability cost.
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
  return { path, documentCount: index.docs.length };
}

/**
 * Read a persisted index. Returns `null` if the file is missing,
 * unreadable, malformed, or written by an incompatible version.
 */
export function readSearchIndex(
  configDir: string,
): PersistedSearchIndex | null {
  const path = searchIndexPath(configDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as PersistedSearchIndex;
    if (parsed?.version !== INDEX_VERSION) return null;
    if (!Array.isArray(parsed.docs)) return null;
    if (!parsed.items || typeof parsed.items !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Pick the first non-blank line of `body` as a one-line summary. */
function firstNonBlankLine(
  body: string,
  refName: string,
  fileName: string,
): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    return line;
  }
  return `${refName}/${fileName}`;
}

/**
 * Pull the actual tool name from the .tool.json. Falls back to the
 * filename (without .tool.md) if the json is missing or unreadable —
 * still useful as a search anchor even if not exact.
 */
function parseToolName(toolJsonPath: string, fileName: string): string {
  if (existsSync(toolJsonPath)) {
    try {
      const obj = JSON.parse(readFileSync(toolJsonPath, "utf-8")) as {
        name?: string;
      };
      if (typeof obj.name === "string" && obj.name.length > 0) return obj.name;
    } catch {
      // fall through
    }
  }
  return fileName.replace(/\.tool\.md$/, "");
}

/**
 * Pull parameter names + descriptions out of a .tool.json's inputSchema.
 * Surfaces them as plain text into the BM25 index so queries like
 * "calendar event id" land on the right tool.
 */
function extractParamText(toolJsonPath: string): string {
  if (!existsSync(toolJsonPath)) return "";
  try {
    const obj = JSON.parse(readFileSync(toolJsonPath, "utf-8")) as {
      description?: string;
      inputSchema?: { properties?: Record<string, { description?: string }> };
    };
    const parts: string[] = [];
    if (obj.description) parts.push(obj.description);
    const props = obj.inputSchema?.properties ?? {};
    for (const [name, info] of Object.entries(props)) {
      parts.push(name);
      if (typeof info?.description === "string") parts.push(info.description);
    }
    return parts.join(" ");
  } catch {
    return "";
  }
}

// ============================================
// Search
// ============================================

/**
 * Run a BM25 search over the materialized refs.
 *
 * Prefers the persisted `<configDir>/search-index.json` (written by
 * `adk sync`) when it exists — that path skips the recursive walk and
 * runs in single-digit ms even with hundreds of tools. Falls back to a
 * fresh walk of `refsRoot` when the persisted file is missing or stale.
 *
 * @param refsRoot The materialized refs directory (e.g. `~/.adk/refs`).
 *   We derive `<configDir>` from this as the parent so callers don't
 *   have to plumb both. Pass an `index` directly via `options.index` to
 *   bypass disk I/O entirely (used by tests).
 */
export function searchRefs(
  refsRoot: string,
  query: string,
  options: SearchOptions & { index?: PersistedSearchIndex } = {},
): SearchResult[] {
  const index =
    options.index ??
    readSearchIndex(dirname(refsRoot)) ??
    buildSearchIndex(refsRoot);

  const bm25 = createBM25Index(index.docs);
  const limit = options.limit ?? 10;
  // Pull more raw hits than `limit` so the kind / ref filters below have
  // headroom to drop irrelevant matches without short-changing the caller.
  // 5x is plenty for typical 10-20 limits.
  const raw = bm25.search(query, limit * 5);

  const results: SearchResult[] = [];
  for (const hit of raw) {
    if (results.length >= limit) break;
    const item = index.items[hit.id];
    if (!item) continue;
    if (options.toolsOnly && item.kind !== "tool") continue;
    if (options.refsOnly && item.kind !== "ref") continue;
    if (options.ref && !refMatches(options.ref, item.ref)) continue;
    // Spread the stored item and tack on the query-time score. Each
    // `item` matches one of the `SearchResult` variants by construction
    // (see `buildSearchIndex`), so this is type-safe.
    results.push({ ...item, score: hit.score } as SearchResult);
  }

  return results;
}

/** Match `ref` filter loosely — accepts both bare names and `/agents/@…` paths. */
function refMatches(filter: string, ref: string): boolean {
  if (filter === ref) return true;
  // Allow `@clock` as a shorthand for `/agents/@clock`, and vice versa.
  if (ref === `/agents/${filter}`) return true;
  if (`/agents/${ref}` === filter) return true;
  return false;
}

// ============================================
// CLI rendering
// ============================================

/** Concise human-readable rendering — one numbered block per result. */
export function renderResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results.";
  const blocks: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const score = r.score.toFixed(2);
    if (r.kind === "tool") {
      blocks.push(
        [
          `${i + 1}. ${r.ref}.${r.tool}  score=${score}`,
          `   ${r.summary}`,
          `   Docs: ${r.docs}`,
          `   Call: ${r.call}`,
        ].join("\n"),
      );
    } else if (r.kind === "ref") {
      blocks.push(
        [
          `${i + 1}. ${r.ref}  (ref, ${r.toolCount} tools)  score=${score}`,
          `   ${r.summary}`,
          `   Docs: ${r.docs}`,
        ].join("\n"),
      );
    } else {
      blocks.push(
        [
          `${i + 1}. ${r.ref}/${r.resource}  (resource)  score=${score}`,
          `   ${r.summary}`,
          `   Docs: ${r.docs}`,
        ].join("\n"),
      );
    }
  }
  return blocks.join("\n\n");
}

// Local helpers — exposed so callers (the CLI) can detect a missing
// refs root and print a useful message instead of an empty result list.
export function refsRootExists(refsRoot: string): boolean {
  return existsSync(refsRoot) && statSync(refsRoot).isDirectory();
}
