#!/usr/bin/env bun
/**
 * ADK CLI — Agent Development Kit
 *
 * Unified CLI for building, testing, and publishing agent definitions.
 *
 * Commands:
 *   codegen     Generate agent definitions from an MCP server (full codegen)
 *   introspect  Introspect an MCP server → agent.json (lightweight)
 *   pack        Generate publishable @agentdef/* package from agent.json
 *   publish     Pack + npm publish to @agentdef/*
 *   use         Execute a tool on a generated agent
 *   list        List all generated agents
 *
 * @example
 * ```bash
 * # Full codegen from MCP server
 * adk codegen --server 'npx @mcp/notion' --name notion --out ./agents/@notion
 *
 * # Lightweight introspect → agent.json
 * adk introspect --server 'npx @notionhq/notion-mcp-server' --name notion
 *
 * # Build + publish
 * adk pack
 * adk publish
 *
 * # Use a tool
 * adk use notion search_pages '{"query": "hello"}'
 * adk use notion --list
 * ```
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { codegen, listAgentTools, useAgent } from "./codegen.js";
import type { CodegenManifest } from "./codegen.js";
import { pack, publish } from "./pack.js";
import {
  cmdInit,
  cmdSearch,
  cmdAdd,
  cmdRemove,
  cmdInfo,
  cmdCall,
  cmdListConsumer,
  cmdServe,
  cmdLogin,
  isInitialized,
  listRefs,
} from "./adk/index.js";

const args = process.argv.slice(2);
const command = args[0];

// ============================================
// Helpers
// ============================================

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function getAgentsDir(): string {
  return resolve(process.env.AGENTS_SDK_DIR ?? "./agents");
}

function findAgentDir(name: string): string | null {
  const agentsDir = getAgentsDir();

  const exactPath = resolve(name);
  if (existsSync(join(exactPath, ".codegen-manifest.json"))) return exactPath;

  const withAt = join(agentsDir, `@${name}`);
  if (existsSync(join(withAt, ".codegen-manifest.json"))) return withAt;

  const withoutAt = join(agentsDir, name);
  if (existsSync(join(withoutAt, ".codegen-manifest.json"))) return withoutAt;

  return null;
}

function printUsage() {
  // Show configured agents if initialized
  let agentsSummary = "";
  try {
    if (isInitialized()) {
      const refs = listRefs();
      if (refs.length > 0) {
        agentsSummary = "\nYour agents:\n";
        for (const { name, ref, hasSecrets } of refs) {
          const alias = name !== ref ? ` (${ref})` : "";
          const creds = hasSecrets ? "  \u{1F511}" : "";
          agentsSummary += `  ${name}${alias}${creds}\n`;
        }
      }
    }
  } catch {
    // Not initialized, skip
  }

  console.log(`
adk \u2014 Agent Development Kit

Call and manage integrations from the command line.
Config: ~/adk/config.json

Commands:
  adk init                           Initialize ~/adk/ (config, secrets, key)
  adk search [query]                 Search the registry for agents
  adk add <agent> [--as <alias>]     Add an agent (prompts for credentials)
  adk remove <agent>                 Remove an agent
  adk list                           List your configured agents
  adk call <agent> <tool> [json]     Call a tool on an agent
  adk info <agent>                   Show agent details + all tools
  adk serve [--port <port>]          Start local MCP server with all agents
  adk login                          Authenticate with registry.slash.com

  adk codegen [options]              Generate agent from MCP server (full codegen)
  adk introspect [options]           Introspect MCP server \u2192 agent.json
  adk pack [options]                 Generate publishable package from agent.json
  adk publish [options]              Pack + npm publish to @agentdef/*
  adk use <agent> [options]          Execute a tool on a generated agent
${agentsSummary}
Run \`adk call <agent> <tool> --help\` for params.
Run \`adk search\` to discover more integrations.
`);
}

// ============================================
// Commands
// ============================================

async function runCodegen() {
  const server = getArg("--server");
  const name = getArg("--name");
  const outDir = getArg("--out");
  const agentPath = getArg("--path");
  const visibility = getArg("--visibility") as
    | "public"
    | "internal"
    | "private"
    | undefined;
  const noCli = hasFlag("--no-cli");
  const noTypes = hasFlag("--no-types");

  if (!server) {
    console.error(
      "Error: --server is required.\n" +
        "  Example: adk codegen --server 'npx @mcp/notion' --name notion",
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
    console.log("\nFiles:");
    for (const f of result.files) {
      console.log(`  ${f}`);
    }
    console.log(
      `\nUse: adk use ${name ?? result.serverInfo.name ?? "<agent>"} --list`,
    );
  } catch (err) {
    console.error(
      `\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

async function runIntrospect() {
  const server = getArg("--server");
  const name = getArg("--name");
  const out = getArg("--out") || (name ? `./${name}.json` : undefined);

  if (!server || !name) {
    console.error(
      "Usage: adk introspect --server <cmd> --name <name> [--out <path>]",
    );
    process.exit(1);
  }

  const { introspectMcp } = await import("./introspect.js");
  await introspectMcp({ server, name, out });
}

function runPack() {
  const agentFile = getArg("--agent") || "./agent.json";
  const outDir = getArg("--out") || "./dist";
  const scope = getArg("--scope") || "@agentdef";
  const previousAgentFile = getArg("--previous");

  if (!existsSync(resolve(agentFile))) {
    console.error(`agent.json not found at ${resolve(agentFile)}`);
    console.error("Run 'adk introspect' first, or specify --agent <path>");
    process.exit(1);
  }

  const result = pack({ agentFile, outDir, scope, previousAgentFile });
  console.log(`\n\u2705 Packed ${result.packageName}@${result.version}`);
  console.log(`   Hash: ${result.hash}`);
  console.log(`   Tools: ${result.meta.toolCount}`);
  console.log(`   Size: ${(result.meta.sizeBytes / 1024).toFixed(1)}KB`);
  console.log(`   Output: ${result.packageDir}`);
  if (result.meta.changes) {
    const c = result.meta.changes;
    if (c.toolsAdded.length > 0)
      console.log(`   Added: ${c.toolsAdded.join(", ")}`);
    if (c.toolsRemoved.length > 0)
      console.log(`   Removed: ${c.toolsRemoved.join(", ")}`);
    if (c.toolsModified.length > 0)
      console.log(`   Modified: ${c.toolsModified.join(", ")}`);
  }
}

function runPublish() {
  const agentFile = getArg("--agent") || "./agent.json";
  const outDir = getArg("--out") || "./dist";
  const scope = getArg("--scope") || "@agentdef";
  const previousAgentFile = getArg("--previous");
  const dryRun = hasFlag("--dry-run");
  const tag = getArg("--tag");
  const access = getArg("--access") as "public" | "restricted" | undefined;
  const registry = getArg("--registry");

  if (!existsSync(resolve(agentFile))) {
    console.error(`agent.json not found at ${resolve(agentFile)}`);
    console.error("Run 'adk introspect' first, or specify --agent <path>");
    process.exit(1);
  }

  try {
    const result = publish({
      agentFile,
      outDir,
      scope,
      previousAgentFile,
      dryRun,
      tag,
      access,
      registry,
    });
    console.log(
      `\n\u2705 Published ${result.packageName}@${result.version} (hash: ${result.hash})`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function runUse() {
  const agentName = args[1];

  if (!agentName) {
    console.error(
      "Error: agent name required.\n" +
        "  Example: adk use notion search_pages '{...}'",
    );
    process.exit(1);
  }

  const agentDir = findAgentDir(agentName);
  if (!agentDir) {
    console.error(
      `Error: agent '${agentName}' not found.\n` +
        `  Looked in: ${getAgentsDir()}\n` +
        `  Generate first: adk codegen --server '...' --name ${agentName}`,
    );
    process.exit(1);
  }

  if (hasFlag("--list")) {
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
      `Error: tool name required.\n  Example: adk use ${agentName} <tool> [params]\n  List tools: adk use ${agentName} --list`,
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

// ============================================
// Main
// ============================================

const subArgs = args.slice(1);

switch (command) {
  // Consumer commands
  case "init":
    await cmdInit(subArgs);
    break;
  case "search":
    await cmdSearch(subArgs);
    break;
  case "add":
    await cmdAdd(subArgs);
    break;
  case "remove":
    await cmdRemove(subArgs);
    break;
  case "info":
    await cmdInfo(subArgs);
    break;
  case "call":
    await cmdCall(subArgs);
    break;
  case "serve":
    await cmdServe(subArgs);
    break;
  case "login":
    await cmdLogin(subArgs);
    break;
  case "list":
    // Show both consumer refs and codegen'd agents
    await cmdListConsumer(subArgs);
    runList();
    break;

  // Builder commands
  case "codegen":
    await runCodegen();
    break;
  case "introspect":
    await runIntrospect();
    break;
  case "pack":
    runPack();
    break;
  case "publish":
    runPublish();
    break;
  case "use":
    await runUse();
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
