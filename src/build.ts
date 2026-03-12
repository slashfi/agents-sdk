/**
 * Build Agents
 *
 * Scans a directory for agent definitions and generates a registry file.
 *
 * Convention:
 * - Agent directories start with `@` (e.g., `@my-agent`)
 * - Each agent has:
 *   - `entrypoint.md` - System prompt
 *   - `agent.config.ts` - Configuration (exports default AgentConfig)
 *   - `*.tool.ts` - Tool definitions (exports `{toolName}Tool`)
 *
 * @example
 * ```typescript
 * // scripts/build-agents.ts
 * import { buildAgents } from '@slashfi/agents-sdk';
 *
 * await buildAgents({
 *   agentsDir: './src/agents',
 *   outFile: './src/agents/_generated-registry.ts',
 * });
 * ```
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Options for building agents.
 */
export interface BuildAgentsOptions {
  /** Directory containing agent folders (e.g., './src/agents') */
  agentsDir: string;

  /** Output file path for the generated registry */
  outFile: string;

  /**
   * Import path for the SDK.
   * @default '@slashfi/agents-sdk'
   */
  sdkImport?: string;

  /**
   * Default visibility for agents.
   * @default 'internal'
   */
  defaultVisibility?: "public" | "internal" | "private";

  /**
   * Whether to use double quotes for strings.
   * @default false (single quotes)
   */
  doubleQuotes?: boolean;
}

/**
 * Result of building agents.
 */
export interface BuildAgentsResult {
  /** Number of agents processed */
  agentCount: number;

  /** Paths of agents that were processed */
  agents: string[];

  /** Agents that were skipped (missing required files) */
  skipped: string[];

  /** Path to the generated output file */
  outFile: string;
}

/**
 * Convert kebab-case to camelCase.
 */
function toCamelCase(str: string): string {
  return str
    .split("-")
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
}

/**
 * Escape a string for use in a JavaScript string literal.
 */
function escapeString(str: string, quote: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(quote, "g"), `\\${quote}`)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Build agents from a directory.
 *
 * Scans the given directory for agent folders (starting with `@`) and generates
 * a TypeScript file that creates and populates an agent registry.
 */
export async function buildAgents(
  options: BuildAgentsOptions,
): Promise<BuildAgentsResult> {
  const {
    agentsDir,
    outFile,
    sdkImport = "@slashfi/agents-sdk",
    defaultVisibility = "internal",
    doubleQuotes = false,
  } = options;

  const q = doubleQuotes ? '"' : "'";
  const agents: string[] = [];
  const skipped: string[] = [];

  // Find all agent directories (start with @)
  const agentDirs = readdirSync(agentsDir).filter((name) => {
    if (!name.startsWith("@")) return false;
    try {
      const stat = statSync(join(agentsDir, name));
      return stat.isDirectory();
    } catch {
      return false;
    }
  });

  const imports: string[] = [];
  const registrations: string[] = [];
  const exportItems: string[] = [];

  for (const agentDir of agentDirs) {
    const agentPath = join(agentsDir, agentDir);
    const entrypointPath = join(agentPath, "entrypoint.md");
    const configPath = join(agentPath, "agent.config.ts");

    // Check if required files exist
    try {
      statSync(entrypointPath);
      statSync(configPath);
    } catch {
      skipped.push(agentDir);
      continue;
    }

    // Read entrypoint content
    const entrypoint = readFileSync(entrypointPath, "utf-8");

    // Find tool files
    const toolFiles = readdirSync(agentPath).filter((f) =>
      f.endsWith(".tool.ts"),
    );

    // Generate variable name from directory (e.g., @product-applications -> productApplications)
    const varName = toCamelCase(agentDir.slice(1));

    // Add config import
    imports.push(
      `import ${varName}Config from ${q}./${agentDir}/agent.config.js${q};`,
    );

    // Add tool imports and collect tool info
    const toolEntries: Array<{ varName: string; name: string }> = [];
    for (const toolFile of toolFiles) {
      const baseName = toolFile.replace(".tool.ts", "");
      // Convert kebab-case to camelCase for JS variable: get-status -> getStatusTool
      const toolVarName = `${toCamelCase(baseName)}Tool`;
      // Tool name is just the filename (kebab-case): get-status
      const toolName = baseName;
      imports.push(
        `import { ${toolVarName} } from ${q}./${agentDir}/${toolFile.replace(".ts", ".js")}${q};`,
      );
      toolEntries.push({ varName: toolVarName, name: toolName });
    }

    // Read config to get the path override if specified
    const configContent = readFileSync(configPath, "utf-8");
    const pathMatch = configContent.match(/path:\s*['"]([^'"]+)['"]/);
    const registeredPath = pathMatch ? pathMatch[1] : agentDir;

    // Generate tools array with name override
    const toolsArray = toolEntries
      .map((t) => `{ ...${t.varName}, name: ${q}${t.name}${q} }`)
      .join(", ");

    // Generate agent definition
    const entrypointEscaped = escapeString(entrypoint, q);
    registrations.push(`
const ${varName}Agent = defineAgent({
  path: ${q}${registeredPath}${q},
  entrypoint: ${q}${entrypointEscaped}${q},
  config: ${varName}Config,
  tools: [${toolsArray}],
  visibility: ${q}${defaultVisibility}${q},
});
agentRegistry.register(${varName}Agent);`);

    exportItems.push(`  ${varName}: ${varName}Agent,`);
    agents.push(registeredPath);
  }

  const output = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT
 * Generated by buildAgents from ${sdkImport}
 *
 * This file bundles agent entrypoints at build time.
 * Tool names are derived from filenames (kebab-case).
 */

import { createAgentRegistry, defineAgent } from ${q}${sdkImport}${q};

${imports.join("\n")}

// Create registry
export const agentRegistry = createAgentRegistry({
  defaultVisibility: ${q}${defaultVisibility}${q},
});

// Register agents
${registrations.join("\n")}

// Export agents
export const agents = {
${exportItems.join("\n")}
};
`;

  writeFileSync(outFile, output);

  return {
    agentCount: agents.length,
    agents,
    skipped,
    outFile,
  };
}
