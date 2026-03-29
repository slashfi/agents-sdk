#!/usr/bin/env bun
/**
 * agents-sdk CLI
 *
 * Unified command-line interface for the agents SDK.
 *
 * Commands:
 *   codegen  - Generate agent definitions from an MCP server
 *   use      - Execute a tool on a codegenned agent
 *
 * @example
 * ```bash
 * # Generate from MCP server
 * agents-sdk codegen --server 'npx @mcp/notion' --name notion --out ./agents/@notion
 *
 * # Use a tool
 * agents-sdk use notion search_pages '{"query": "hello"}'
 *
 * # List tools on a codegenned agent
 * agents-sdk use notion --list
 * ```
 */

import { resolve, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { codegen, useAgent, listAgentTools } from "./codegen.js";
import type { CodegenManifest } from "./codegen.js";

const args = process.argv.slice(2);
const command = args[0];

// ============================================
// Helpers
// ============================================

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Default directory for codegenned agents */
function getAgentsDir(): string {
  return resolve(process.env.AGENTS_SDK_DIR ?? "./agents");
}

/** Find an agent directory by name */
function findAgentDir(name: string): string | null {
  const agentsDir = getAgentsDir();

  // Try exact path first
  const exactPath = resolve(name);
  if (existsSync(join(exactPath, ".codegen-manifest.json"))) {
    return exactPath;
  }

  // Try under agents dir with @ prefix
  const withAt = join(agentsDir, `@${name}`);
  if (existsSync(join(withAt, ".codegen-manifest.json"))) {
    return withAt;
  }

  // Try under agents dir without @ prefix
  const withoutAt = join(agentsDir, name);
  if (existsSync(join(withoutAt, ".codegen-manifest.json"))) {
    return withoutAt;
  }

  return null;
}

function printUsage() {
  console.log(`agents-sdk - SDK for building AI agents

Usage:
  agents-sdk codegen [options]     Generate agent from MCP server
  agents-sdk use <agent> [options] Execute a tool on a generated agent
  agents-sdk list                  List all generated agents

Codegen options:
  --server <source>     MCP server (command string or URL)
  --name <name>         Agent name (default: derived from server)
  --out <dir>           Output directory (default: ./agents/@<name>)
  --path <path>         Agent path override
  --no-cli              Skip CLI generation
  --no-types            Skip TypeScript interface generation
  --visibility <level>  Agent visibility (public|internal|private)

Use options:
  agents-sdk use <agent> <tool> [params_json]
  agents-sdk use <agent> --list   List tools on the agent

Examples:
  agents-sdk codegen --server 'npx @mcp/notion' --name notion
  agents-sdk use notion search_pages '{"query": "hello"}'
  agents-sdk use notion --list
`);
}

// ============================================
// Commands
// ============================================

async function runCodegen(args: string[]) {
  const server = parseFlag(args, "--server");
  const name = parseFlag(args, "--name");
  const outDir = parseFlag(args, "--out");
  const agentPath = parseFlag(args, "--path");
  const visibility = parseFlag(args, "--visibility") as
    | "public"
    | "internal"
    | "private"
    | undefined;
  const noCli = hasFlag(args, "--no-cli");
  const noTypes = hasFlag(args, "--no-types");

  if (!server) {
    console.error(
      "Error: --server is required.\n" +
        "  Example: agents-sdk codegen --server 'npx @mcp/notion' --name notion",
    );
    process.exit(1);
  }

  const resolvedOutDir =
    outDir ??
    join(
      getAgentsDir(),
      `@${(name ?? "mcp-agent").toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
    );

  console.log(`Connecting to MCP server: ${server}`);
  console.log(`Output: ${resolvedOutDir}\n`);

  try {
    const result = await codegen({
      server,
      outDir: resolvedOutDir,
      agentPath,
      name,
      cli: !noCli,
      types: !noTypes,
      visibility,
    });

    console.log(
      `\x1b[32m\u2713\x1b[0m Generated ${result.toolCount} tools from ${result.serverInfo.name ?? "MCP server"}`,
    );
    console.log(`\nFiles:`);
    for (const f of result.files) {
      console.log(`  ${f}`);
    }
    console.log(
      `\nUse: agents-sdk use ${name ?? result.serverInfo.name ?? "<agent>"} --list`,
    );
  } catch (err) {
    console.error(
      `\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

async function runUse(args: string[]) {
  const agentName = args[1];

  if (!agentName) {
    console.error(
      "Error: agent name required.\n" +
        "  Example: agents-sdk use notion search_pages '{...}'",
    );
    process.exit(1);
  }

  const agentDir = findAgentDir(agentName);
  if (!agentDir) {
    console.error(
      `Error: No generated agent '${agentName}' found.\n` +
        `  Looked in: ${getAgentsDir()}\n` +
        `  Run: agents-sdk codegen --server '...' --name ${agentName}`,
    );
    process.exit(1);
  }

  // --list: show available tools
  if (hasFlag(args, "--list")) {
    const tools = listAgentTools(agentDir);
    console.log(`Tools for ${agentName}:\n`);
    for (const t of tools) {
      console.log(`  ${t.name.padEnd(30)} ${t.description ?? ""}`);
    }
    return;
  }

  const toolName = args[2];
  if (!toolName) {
    console.error(
      `Error: tool name required.\n` +
        `  Example: agents-sdk use ${agentName} <tool> [params]\n` +
        `  List tools: agents-sdk use ${agentName} --list`,
    );
    process.exit(1);
  }

  const paramsStr = args[3];
  const params = paramsStr ? JSON.parse(paramsStr) : {};

  try {
    const result = await useAgent({
      agentDir,
      tool: toolName,
      params,
    });

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(
      `\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

function runList() {
  const agentsDir = getAgentsDir();

  if (!existsSync(agentsDir)) {
    console.log("No generated agents found.");
    return;
  }

  const entries = readdirSync(agentsDir);
  const agents: { name: string; tools: number; server?: string }[] = [];

  for (const entry of entries) {
    const manifestPath = join(agentsDir, entry, ".codegen-manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest: CodegenManifest = JSON.parse(
          require("node:fs").readFileSync(manifestPath, "utf-8"),
        );
        agents.push({
          name: manifest.agentPath,
          tools: manifest.tools.length,
          server: manifest.serverInfo.name,
        });
      } catch {
        agents.push({ name: entry, tools: 0 });
      }
    }
  }

  if (agents.length === 0) {
    console.log("No generated agents found.");
    return;
  }

  console.log("Generated agents:\n");
  for (const a of agents) {
    console.log(
      `  ${a.name.padEnd(25)} ${String(a.tools).padEnd(5)} tools${a.server ? `  (${a.server})` : ""}`,
    );
  }
}

// ============================================
// Main
// ============================================

switch (command) {
  case "codegen":
    await runCodegen(args);
    break;
  case "use":
    await runUse(args);
    break;
  case "list":
    runList();
    break;
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
