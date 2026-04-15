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
    lines.push(`  /** ${tool.description ?? tool.name} */`);
    lines.push(`  ${JSON.stringify(tool.name)}: {`);
    lines.push(`    name: ${JSON.stringify(tool.name)};`);
    if (tool.description) lines.push(`    description: ${JSON.stringify(tool.description)};`);
    lines.push(`    params: Record<string, unknown>;`);
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
    if (info?.tools && info.tools.length > 0) {
      const tools: ToolSchema[] = info.tools.map((t: any) => ({
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
      ensureWrite(join(refDir, "entrypoint.md"), generateEntrypoint(refName, info.description, tools));
      docsGenerated = true;

      // Write agent.json metadata
      ensureWrite(
        join(refDir, "agent.json"),
        JSON.stringify({
          name: refName,
          description: info.description,
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

export async function syncAllRefs(
  adk: Adk,
  configDir: string,
  opts?: { filter?: string; onProgress?: (name: string, status: string) => void },
): Promise<SyncResult> {
  const config = await adk.readConfig();
  const refs = config.refs ?? [];

  const results: SyncResult["refs"] = [];
  let totalTools = 0;
  let totalSkills = 0;

  for (const refEntry of refs) {
    const name = typeof refEntry === "string"
      ? refEntry
      : (refEntry as any).as ?? (refEntry as any).ref ?? (refEntry as any).name;

    if (!name) continue;
    if (opts?.filter && name !== opts.filter) continue;

    opts?.onProgress?.(name, "syncing");

    try {
      const result = await materializeRef(adk, name, configDir);
      results.push({ name, result });
      totalTools += result.toolCount;
      totalSkills += result.skillCount;
      opts?.onProgress?.(name, `done (${result.toolCount} tools)`);
    } catch (err: any) {
      results.push({
        name,
        result: { toolCount: 0, skillCount: 0, typesGenerated: false, docsGenerated: false },
        error: err?.message ?? String(err),
      });
      opts?.onProgress?.(name, `error: ${err?.message ?? "unknown"}`);
    }
  }

  return { refs: results, totalTools, totalSkills };
}
