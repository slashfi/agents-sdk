/**
 * ADK Pack
 *
 * Generates a publishable npm package from an agent.json file.
 *
 * Input: agent.json (SerializedAgentDefinition)
 * Output: ready-to-publish directory with:
 *   - package.json
 *   - agent.json (copy)
 *   - meta.json (version metadata + diff)
 *   - index.js + index.d.ts (typed export)
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseJsonc } from "./jsonc.js";
import type { SerializedAgentDefinition } from "./serialized.js";

// ============================================
// Types
// ============================================

export interface PackOptions {
  /** Path to agent.json */
  agentFile: string;
  /** Output directory (default: ./dist) */
  outDir?: string;
  /** npm scope (default: @agentdef) */
  scope?: string;
  /** Previous version's agent.json path for diff (optional) */
  previousAgentFile?: string;
}

export interface PackResult {
  packageDir: string;
  packageName: string;
  version: string;
  hash: string;
  meta: VersionMeta;
}

export interface VersionMeta {
  hash: string;
  serverVersion: string;
  npmPackage?: string;
  toolCount: number;
  sizeBytes: number;
  generatedAt: string;
  sdkVersion: string;
  changes?: VersionChanges;
}

export interface VersionChanges {
  previousHash?: string;
  toolsAdded: string[];
  toolsRemoved: string[];
  toolsModified: string[];
  schemaChanges: string[];
}

// ============================================
// Hash
// ============================================

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

// ============================================
// Diff
// ============================================

function diffDefinitions(
  current: SerializedAgentDefinition,
  previous: SerializedAgentDefinition,
): VersionChanges {
  const prevToolNames = new Set(previous.tools.map((t) => t.name));
  const currToolNames = new Set(current.tools.map((t) => t.name));

  const toolsAdded = current.tools
    .filter((t) => !prevToolNames.has(t.name))
    .map((t) => t.name);
  const toolsRemoved = previous.tools
    .filter((t) => !currToolNames.has(t.name))
    .map((t) => t.name);

  // Find modified tools (same name, different schema)
  const toolsModified: string[] = [];
  const schemaChanges: string[] = [];
  const prevToolMap = new Map(previous.tools.map((t) => [t.name, t]));

  for (const tool of current.tools) {
    const prev = prevToolMap.get(tool.name);
    if (!prev) continue;
    const currSchema = JSON.stringify(tool.inputSchema);
    const prevSchema = JSON.stringify(prev.inputSchema);
    if (currSchema !== prevSchema) {
      toolsModified.push(tool.name);
      // Generate human-readable schema change description
      const currProps = Object.keys(
        ((tool.inputSchema as Record<string, unknown>).properties as Record<
          string,
          unknown
        >) || {},
      );
      const prevProps = Object.keys(
        ((prev.inputSchema as Record<string, unknown>).properties as Record<
          string,
          unknown
        >) || {},
      );
      const added = currProps.filter((p) => !prevProps.includes(p));
      const removed = prevProps.filter((p) => !currProps.includes(p));
      if (added.length > 0) {
        schemaChanges.push(
          `${tool.name}: added properties: ${added.join(", ")}`,
        );
      }
      if (removed.length > 0) {
        schemaChanges.push(
          `${tool.name}: removed properties: ${removed.join(", ")}`,
        );
      }
      if (added.length === 0 && removed.length === 0) {
        schemaChanges.push(`${tool.name}: schema modified`);
      }
    }
  }

  return {
    previousHash: contentHash(JSON.stringify(previous)),
    toolsAdded,
    toolsRemoved,
    toolsModified,
    schemaChanges,
  };
}

// ============================================
// Pack
// ============================================

export function pack(options: PackOptions): PackResult {
  const { agentFile, outDir = "./dist", scope = "@agentdef" } = options;

  // Read agent.json
  const agentPath = resolve(agentFile);
  if (!existsSync(agentPath)) {
    throw new Error(`agent.json not found: ${agentPath}`);
  }
  const agentContent = readFileSync(agentPath, "utf-8");
  const definition = parseJsonc(agentContent) as SerializedAgentDefinition;

  // Compute hash + version
  const hash = contentHash(agentContent);
  const version = `${definition.version || "1.0.0"}`;
  const packageName = `${scope}/${definition.path}`;

  // Create output directory
  const packageDir = resolve(outDir, definition.path);
  mkdirSync(packageDir, { recursive: true });

  // Generate meta.json
  const meta: VersionMeta = {
    hash,
    serverVersion:
      definition.serverInfo?.version || definition.version || "1.0.0",
    npmPackage: definition.serverSource,
    toolCount: definition.tools.length,
    sizeBytes: Buffer.byteLength(agentContent, "utf-8"),
    generatedAt: definition.generatedAt || new Date().toISOString(),
    sdkVersion: definition.sdkVersion || "0.21.0",
  };

  // Diff against previous if provided
  if (options.previousAgentFile) {
    const prevPath = resolve(options.previousAgentFile);
    if (existsSync(prevPath)) {
      const prevContent = readFileSync(prevPath, "utf-8");
      const prevDef = parseJsonc(prevContent) as SerializedAgentDefinition;
      meta.changes = diffDefinitions(definition, prevDef);
    }
  }

  // Write agent.json
  writeFileSync(resolve(packageDir, "agent.json"), agentContent);

  // Write meta.json
  writeFileSync(
    resolve(packageDir, "meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
  );

  // Write package.json
  const pkg = {
    name: packageName,
    version,
    description:
      definition.description || `Agent definition for ${definition.name}`,
    type: "module",
    main: "index.js",
    types: "index.d.ts",
    exports: {
      ".": {
        import: "./index.js",
        types: "./index.d.ts",
      },
      "./agent.json": "./agent.json",
      "./meta.json": "./meta.json",
    },
    files: ["index.js", "index.d.ts", "agent.json", "meta.json"],
    peerDependencies: {
      "@slashfi/agents-sdk": ">=0.21.0",
    },
    keywords: ["agent", "mcp", "agentdef", definition.path],
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/slashfi/agents-sdk",
    },
  };
  writeFileSync(
    resolve(packageDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );

  // Write index.js
  writeFileSync(
    resolve(packageDir, "index.js"),
    [
      'import { readFileSync } from "node:fs";',
      'import { fileURLToPath } from "node:url";',
      'import { dirname, resolve } from "node:path";',
      "",
      "const __dirname = dirname(fileURLToPath(import.meta.url));",
      'const definition = JSON.parse(readFileSync(resolve(__dirname, "agent.json"), "utf-8"));',
      "export default definition;",
      "export { definition };",
      "",
    ].join("\n"),
  );

  // Write index.d.ts
  writeFileSync(
    resolve(packageDir, "index.d.ts"),
    [
      'import type { SerializedAgentDefinition } from "@slashfi/agents-sdk";',
      "",
      "declare const definition: SerializedAgentDefinition;",
      "export default definition;",
      "export { definition };",
      "",
    ].join("\n"),
  );

  return { packageDir, packageName, version, hash, meta };
}

// ============================================
// Publish
// ============================================

export interface PublishOptions extends PackOptions {
  /** Dry run (don't actually publish) */
  dryRun?: boolean;
  /** npm tag (default: latest) */
  tag?: string;
  /** npm access level */
  access?: "public" | "restricted";
}

export function publish(options: PublishOptions): PackResult {
  const result = pack(options);

  const npmArgs = ["publish", result.packageDir];
  npmArgs.push("--access", options.access || "public");
  if (options.tag) npmArgs.push("--tag", options.tag);
  if (options.dryRun) npmArgs.push("--dry-run");

  console.log(
    `Publishing ${result.packageName}@${result.version} (hash: ${result.hash})`,
  );
  const proc = spawnSync("npm", npmArgs, { stdio: "inherit" });

  if (proc.status !== 0) {
    throw new Error(`npm publish failed with exit code ${proc.status}`);
  }

  return result;
}
