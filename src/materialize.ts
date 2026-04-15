/**
 * Ref Materialization — Download agent docs to local filesystem.
 *
 * When `adk ref add` or `adk sync` runs, materialize the agent's tool schemas,
 * resources (skills), and generate readable markdown docs locally.
 *
 * Output format:
 *   refs/<name>/
 *     agent.json            — metadata (name, description, tool list)
 *     entrypoint.md         — agent overview with tool summary
 *     tools/<tool>.tool.md  — per-tool docs with parameter tables
 *     tools/<tool>.tool.json — raw JSON schemas
 *     types/<name>.d.ts     — TypeScript type stubs
 *     skills/               — resources from the agent
 *
 * The .tool.md files are the primary output — designed for LLMs to read.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adk } from "./config-store.js";
import type { JsonSchema } from "./types.js";

// ============================================
// Types
// ============================================

interface ToolSchema {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: Record<string, unknown>;
}

export interface MaterializeResult {
  toolCount: number;
  skillCount: number;
  typesGenerated: boolean;
  docsGenerated: boolean;
}

export interface SyncResult {
  refs: Array<{ name: string; result: MaterializeResult; error?: string }>;
  totalTools: number;
  totalSkills: number;
}

// ============================================
// File Helpers
// ============================================

function ensureWrite(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, content, "utf-8");
}

function toKebabCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function pascalCase(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase());
}

// ============================================
// JSON Schema → TypeScript type string
// ============================================

function jsonSchemaToTsType(schema: JsonSchema): string {
  if (!schema) return "unknown";

  const s = schema as any;

  // const literal
  if (s.const !== undefined) return JSON.stringify(s.const);

  // enum
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");

  // oneOf / anyOf → union
  if (s.oneOf) return (s.oneOf as JsonSchema[]).map(jsonSchemaToTsType).join(" | ");
  if (s.anyOf) return (s.anyOf as JsonSchema[]).map(jsonSchemaToTsType).join(" | ");

  // allOf → intersection
  if (s.allOf) return (s.allOf as JsonSchema[]).map(jsonSchemaToTsType).join(" & ");

  // $ref
  if (s.$ref) {
    const match = (s.$ref as string).match(/\/([^/]+)$/);
    return match ? match[1] : "unknown";
  }

  switch (schema.type) {
    case "string":
      return s.format ? `string /* ${s.format} */` : "string";
    case "integer":
      return "number /* integer */";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return schema.items ? `${jsonSchemaToTsType(schema.items as JsonSchema)}[]` : "unknown[]";
    case "object": {
      if (schema.properties) {
        const required = new Set((schema.required as string[]) ?? []);
        const props = Object.entries(schema.properties)
          .map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${jsonSchemaToTsType(v as JsonSchema)}`)
          .join("; ");
        if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          const addlType = jsonSchemaToTsType(schema.additionalProperties as JsonSchema);
          return props ? `{ ${props}; [key: string]: ${addlType} }` : `Record<string, ${addlType}>`;
        }
        return `{ ${props} }`;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        return `Record<string, ${jsonSchemaToTsType(schema.additionalProperties as JsonSchema)}>`;
      }
      return "Record<string, unknown>";
    }
    default:
      if (Array.isArray(schema.type)) {
        return (schema.type as string[]).map((t) => (t === "null" ? "null" : t === "integer" ? "number" : t)).join(" | ");
      }
      return "unknown";
  }
}

// ============================================
// Markdown Generation
// ============================================

/** Generate a .tool.md file — readable tool docs with parameter tables. */
function generateToolMd(tool: ToolSchema): string {
  const schema = tool.inputSchema ?? ({ type: "object", properties: {} } as JsonSchema);
  const lines: string[] = [];

  lines.push(`# ${tool.name}`);
  lines.push("");
  if (tool.description) {
    lines.push(tool.description);
    lines.push("");
  }

  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required as string[]) ?? []);
  const paramNames = Object.keys(props);

  if (paramNames.length > 0) {
    lines.push("## Parameters");
    lines.push("");
    lines.push("| Name | Type | Required | Description |");
    lines.push("|------|------|----------|-------------|");
    for (const name of paramNames) {
      const prop = props[name];
      const type = jsonSchemaToTsType(prop);
      const req = required.has(name) ? "✓" : "";
      const desc = (prop.description ?? "").replace(/\|/g, "\\|");
      lines.push(`| ${name} | \`${type}\` | ${req} | ${desc} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Generate entrypoint.md — agent overview with tool listing. */
function generateEntrypoint(refName: string, description: string | undefined, tools: ToolSchema[]): string {
  const lines: string[] = [];
  lines.push(`# ${refName}`);
  lines.push("");
  if (description) {
    lines.push(description);
    lines.push("");
  }
  lines.push(`## Available Tools (${tools.length})`);
  lines.push("");
  for (const tool of tools) {
    lines.push(`- **${tool.name}**: ${tool.description ?? "No description"}`);
  }
  lines.push("");
  lines.push(`> Auto-generated by \`adk sync\` at ${new Date().toISOString()}`);
  lines.push("");
  return lines.join("\n");
}

/** Generate a .d.ts file from tool schemas. */
function generateTypes(refName: string, tools: ToolSchema[]): string {
  const lines: string[] = [
    `// Auto-generated by adk sync`,
    `// Agent: ${refName}`,
    `// Tools: ${tools.length}`,
    ``,
    `export interface ${pascalCase(refName)}Tools {`,
  ];
  for (const tool of tools) {
    const paramsType = tool.inputSchema
      ? jsonSchemaToTsType(tool.inputSchema)
      : "Record<string, unknown>";
    lines.push(`  /** ${tool.description ?? tool.name} */`);
    lines.push(`  ${JSON.stringify(tool.name)}: {`);
    lines.push(`    name: ${JSON.stringify(tool.name)};`);
    if (tool.description) lines.push(`    description: ${JSON.stringify(tool.description)};`);
    lines.push(`    params: ${paramsType};`);
    lines.push(`  };`);
  }
  lines.push(`}`);
  lines.push(``);
  lines.push(`export declare const tools: (keyof ${pascalCase(refName)}Tools)[];`);
  lines.push(``);
  return lines.join("\n");
}

// ============================================
// Materialize a single ref
// ============================================

export async function materializeRef(
  adk: Adk,
  refName: string,
  configDir: string,
): Promise<MaterializeResult> {
  const refDir = join(configDir, "refs", refName);
  const toolsDir = join(refDir, "tools");
  const skillsDir = join(refDir, "skills");
  const typesDir = join(refDir, "types");

  let toolCount = 0;
  let skillCount = 0;
  let typesGenerated = false;
  let docsGenerated = false;

  // 1. Fetch tool schemas and generate docs
  try {
    const info = await adk.ref.inspect(refName, { full: true });
    // Local agents return `tools` (with inputSchema); redirect agents
    // may only return `toolSummaries` (name + description). Use whichever
    // is available so redirect-mode refs still get docs materialized.
    const rawTools = info?.tools ?? info?.toolSummaries;
    if (rawTools && rawTools.length > 0) {
      const tools: ToolSchema[] = rawTools.map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
      }));

      // Write .tool.md files (primary output — readable by LLMs)
      for (const tool of tools) {
        const safeName = toKebabCase(tool.name);
        ensureWrite(join(toolsDir, `${safeName}.tool.md`), generateToolMd(tool));
        ensureWrite(join(toolsDir, `${safeName}.tool.json`), JSON.stringify(tool, null, 2));
      }
      toolCount = tools.length;

      // Write entrypoint.md
      ensureWrite(join(refDir, "entrypoint.md"), generateEntrypoint(refName, info?.description, tools));
      docsGenerated = true;

      // Write agent.json metadata
      ensureWrite(
        join(refDir, "agent.json"),
        JSON.stringify({
          name: refName,
          description: info?.description,
          toolCount: tools.length,
          tools: tools.map((t) => t.name),
          materializedAt: new Date().toISOString(),
        }, null, 2),
      );

      // Generate .d.ts
      ensureWrite(join(typesDir, `${refName}.d.ts`), generateTypes(refName, tools));
      typesGenerated = true;
    }
  } catch {
    // inspect failed — agent might not be reachable yet (needs auth)
  }

  // 2. Fetch and write resources (skills)
  try {
    const resourcesResult = await adk.ref.resources(refName);
    const response = resourcesResult as any;
    if (response?.result?.resources) {
      for (const resource of response.result.resources) {
        if (resource.uri && resource.text) {
          const filename = resource.uri.split("/").pop() ?? "resource.md";
          ensureWrite(join(skillsDir, filename), resource.text);
          skillCount++;
        }
      }
    }
  } catch {
    // resources fetch failed — might not be supported
  }

  return { toolCount, skillCount, typesGenerated, docsGenerated };
}

// ============================================
// Sync all refs from consumer config
// ============================================

const DEFAULT_CONCURRENCY = 3;

export async function syncAllRefs(
  adk: Adk,
  configDir: string,
  opts?: { filter?: string; concurrency?: number; onProgress?: (name: string, status: string) => void },
): Promise<SyncResult> {
  const config = await adk.readConfig();
  const refs = config.refs ?? [];

  // Resolve ref names and filter
  const names: string[] = [];
  for (const refEntry of refs) {
    const name = typeof refEntry === "string"
      ? refEntry
      : (refEntry as any).as ?? (refEntry as any).ref ?? (refEntry as any).name;
    if (!name) continue;
    if (opts?.filter && name !== opts.filter) continue;
    names.push(name);
  }

  const results: SyncResult["refs"] = [];
  let totalTools = 0;
  let totalSkills = 0;
  const concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY;

  // Process in batches of `concurrency`
  for (let i = 0; i < names.length; i += concurrency) {
    const batch = names.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (name) => {
        opts?.onProgress?.(name, "syncing");
        try {
          const result = await materializeRef(adk, name, configDir);
          opts?.onProgress?.(name, `done (${result.toolCount} tools)`);
          return { name, result };
        } catch (err: any) {
          const error = err?.message ?? String(err);
          opts?.onProgress?.(name, `error: ${error}`);
          return {
            name,
            result: { toolCount: 0, skillCount: 0, typesGenerated: false, docsGenerated: false } as MaterializeResult,
            error,
          };
        }
      }),
    );

    for (const settled of batchResults) {
      if (settled.status === "fulfilled") {
        results.push(settled.value);
        totalTools += settled.value.result.toolCount;
        totalSkills += settled.value.result.skillCount;
      }
    }
  }

  const syncResult = { refs: results, totalTools, totalSkills };

  // Generate root type file that aggregates all ref types
  generateRootTypes(configDir, syncResult);

  return syncResult;
}

// ============================================
// Root type generation
// ============================================

/**
 * Generate a root `adk.d.ts` that wires all synced refs into a single
 * AgentRegistry type. This lets callers get autocomplete on agent paths
 * and tool names.
 *
 * Usage: add `/// <reference path="~/.adk/adk.d.ts" />` or include the
 * file path in tsconfig `compilerOptions.typeRoots` / `include`.
 */
export function generateRootTypes(
  configDir: string,
  syncResult: SyncResult,
): void {
  const lines: string[] = [
    `// Auto-generated by adk sync — do not edit`,
    `// Run \`adk sync\` to regenerate`,
    ``,
  ];

  // Collect all successful refs that generated types
  const typedRefs: Array<{ name: string; interfaceName: string; tools: string[] }> = [];

  for (const ref of syncResult.refs) {
    if (ref.error || !ref.result.typesGenerated) continue;

    // Read the agent.json to get tool names
    const agentJsonPath = join(configDir, "refs", ref.name, "agent.json");
    if (!existsSync(agentJsonPath)) continue;

    try {
      const agentJson = JSON.parse(
        require("node:fs").readFileSync(agentJsonPath, "utf-8"),
      );
      const interfaceName = pascalCase(ref.name) + "Tools";
      typedRefs.push({
        name: ref.name,
        interfaceName,
        tools: agentJson.tools ?? [],
      });
    } catch {
      continue;
    }
  }

  if (typedRefs.length === 0) return;

  // Import each per-ref type and re-export
  for (const ref of typedRefs) {
    // Use relative path from configDir root
    const relPath = `./refs/${ref.name}/types/${ref.name}`;
    lines.push(`export { ${ref.interfaceName} } from ${JSON.stringify(relPath)};`);
  }

  lines.push(``);
  lines.push(`/** All synced agents and their tool interfaces */`);
  lines.push(`export interface AdkAgentRegistry {`);
  for (const ref of typedRefs) {
    lines.push(`  ${JSON.stringify(ref.name)}: import(${JSON.stringify(`./refs/${ref.name}/types/${ref.name}`)}).${ref.interfaceName};`);
  }
  lines.push(`}`);
  lines.push(``);
  lines.push(`/** Union of all known agent paths */`);
  lines.push(`export type AgentPath = keyof AdkAgentRegistry;`);
  lines.push(``);
  lines.push(`/** Get tool names for a given agent */`);
  lines.push(`export type ToolsOf<A extends AgentPath> = keyof AdkAgentRegistry[A] & string;`);
  lines.push(``);
  lines.push(`/** Get params type for a specific agent + tool */`);
  lines.push(`export type ParamsOf<A extends AgentPath, T extends ToolsOf<A>> = AdkAgentRegistry[A][T] extends { params: infer P } ? P : Record<string, unknown>;`);
  lines.push(``);

  ensureWrite(join(configDir, "adk.d.ts"), lines.join("\n"));
}
