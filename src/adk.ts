#!/usr/bin/env bun
/**
 * ADK CLI
 *
 * Agent Development Kit — build, test, and publish agent definitions.
 *
 * Usage:
 *   adk introspect --server 'npx @notionhq/notion-mcp-server' --name notion
 *   adk pack [--agent agent.json] [--out dist/]
 *   adk publish [--agent agent.json] [--dry-run] [--tag latest]
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pack, publish } from "./pack.js";

const args = process.argv.slice(2);
const command = args[0];

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function printHelp() {
  console.log(`
adk — Agent Development Kit

Usage:
  adk introspect --server <cmd> --name <name>  Introspect an MCP server → agent.json
  adk pack [options]                            Generate publishable package from agent.json
  adk publish [options]                         Pack + npm publish to @agentdef/*

Pack / Publish options:
  --agent <path>     Path to agent.json (default: ./agent.json)
  --out <dir>        Output directory (default: ./dist)
  --scope <scope>    npm scope (default: @agentdef)
  --previous <path>  Previous agent.json for diff
  --dry-run          Don't actually publish (publish only)
  --tag <tag>        npm dist-tag (default: latest)
  --access <level>   npm access: public | restricted (default: public)
`);
}

async function main() {
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "introspect") {
    // Delegate to the existing codegen/introspect logic
    const server = getArg("--server");
    const name = getArg("--name");
    const out = getArg("--out") || `./${name || "agent"}.json`;

    if (!server || !name) {
      console.error(
        "Usage: adk introspect --server <cmd> --name <name> [--out <path>]",
      );
      process.exit(1);
    }

    // Dynamic import to avoid loading heavy deps if not needed
    const { introspectMcp } = await import("./introspect.js");
    await introspectMcp({ server, name, out });
    return;
  }

  if (command === "pack" || command === "publish") {
    const agentFile = getArg("--agent") || "./agent.json";
    const outDir = getArg("--out") || "./dist";
    const scope = getArg("--scope") || "@agentdef";
    const previousAgentFile = getArg("--previous");

    if (!existsSync(resolve(agentFile))) {
      console.error(`agent.json not found at ${resolve(agentFile)}`);
      console.error("Run 'adk introspect' first, or specify --agent <path>");
      process.exit(1);
    }

    if (command === "pack") {
      const result = pack({ agentFile, outDir, scope, previousAgentFile });
      console.log(`\n✅ Packed ${result.packageName}@${result.version}`);
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
    } else {
      const dryRun = hasFlag("--dry-run");
      const tag = getArg("--tag");
      const access = getArg("--access") as "public" | "restricted" | undefined;

      const result = publish({
        agentFile,
        outDir,
        scope,
        previousAgentFile,
        dryRun,
        tag,
        access,
      });
      console.log(
        `\n✅ Published ${result.packageName}@${result.version} (hash: ${result.hash})`,
      );
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
