#!/usr/bin/env bun
/**
 * ADK CLI — Agent Development Kit
 *
 * Commands:
 *   codegen          Generate agent definitions from an MCP server
 *   introspect       Introspect an MCP server → agent.json
 *   pack             Generate publishable @agentdef/* package
 *   publish          Pack + npm publish to @agentdef/*
 *   use              Execute a tool on a generated agent
 *   list             List all generated agents
 *   registry <op>    Manage registry connections (add, remove, list, browse, inspect, test)
 *   ref <op>         Manage agent refs (add, remove, list, get, inspect, call, resources, read)
 *
 * @example
 * ```bash
 * adk registry add https://registry.slash.com --name slash
 * adk registry browse slash
 * adk ref add notion --registry slash
 * adk ref inspect notion
 * adk ref call notion notion-search '{"query":"hello"}'
 * ```
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { codegen, listAgentTools, useAgent } from "./codegen.js";
import type { CodegenManifest } from "./codegen.js";
import { pack, publish } from "./pack.js";
import { createAdk } from "./config-store.js";
import { createLocalFsStore, getLocalEncryptionKey } from "./local-fs.js";
import type { Adk } from "./config-store.js";

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

function getAdk(): Adk {
  const token = process.env.ADK_TOKEN ?? undefined;
  const encryptionKey = getLocalEncryptionKey();
  return createAdk(createLocalFsStore(), { token, encryptionKey });
}

function printUsage() {
  console.log(`
adk — Agent Development Kit

Usage:
  adk registry <op> [options]        Manage registry connections
  adk ref <op> [options]             Manage agent refs
  adk codegen [options]              Generate agent from MCP server
  adk introspect [options]           Introspect MCP server → agent.json
  adk pack [options]                 Generate publishable package from agent.json
  adk publish [options]              Pack + npm publish to @agentdef/*
  adk use <agent> [options]          Execute a tool on a generated agent
  adk list                           List all generated agents

Registry operations:
  adk registry add <url> --name <name> [--auth-type bearer|api-key|none]
  adk registry remove <name>
  adk registry list
  adk registry browse <name> [--query <q>]
  adk registry inspect <name>
  adk registry test [name]

Ref operations:
  adk ref add <ref> [--registry <name>] [--as <alias>] [--url <url>] [--scheme mcp|https|registry]
  adk ref remove <name>
  adk ref list
  adk ref get <name>
  adk ref inspect <name> [--full]
  adk ref call <name> <tool> [params_json]
  adk ref resources <name>
  adk ref read <name> <uri> [uri...]
  adk ref auth <name> [--api-key <key>]
  adk ref auth-status <name>

Environment:
  ADK_CONFIG_DIR        Config directory (default: ~/.adk)
  ADK_TOKEN             Bearer token for authenticated registries
  ADK_ENCRYPTION_KEY    Override encryption key (default: auto from ~/.adk/.encryption-key)

Examples:
  adk registry add https://registry.slash.com --name slash
  adk registry browse slash
  adk ref add notion --registry slash
  adk ref inspect notion --full
  adk ref call notion notion-search '{"query":"hello"}'
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
// Registry CLI
// ============================================

async function runRegistry() {
  const op = args[1];
  const adk = getAdk();

  switch (op) {
    case "add": {
      const url = args[2];
      const name = getArg("--name");
      if (!url) {
        console.error("Usage: adk registry add <url> --name <name>");
        process.exit(1);
      }
      const authType = getArg("--auth-type") as "bearer" | "api-key" | "none" | undefined;
      const auth = authType && authType !== "none"
        ? { type: authType as "bearer" | "api-key" }
        : undefined;
      await adk.registry.add({ url, name: name ?? new URL(url).hostname, ...(auth && { auth }) });
      console.log(`Added registry: ${name ?? url}`);
      break;
    }
    case "remove": {
      const name = args[2];
      if (!name) { console.error("Usage: adk registry remove <name>"); process.exit(1); }
      const removed = await adk.registry.remove(name);
      console.log(removed ? `Removed: ${name}` : `Not found: ${name}`);
      break;
    }
    case "list": {
      const registries = await adk.registry.list();
      if (registries.length === 0) {
        console.log("No registries configured. Run: adk registry add <url> --name <name>");
        break;
      }
      console.log(`\n${registries.length} registry(s)\n`);
      for (const r of registries) {
        console.log(`  ${r.name ?? r.url}`);
        console.log(`    ${r.url}`);
        if (r.auth) console.log(`    auth: ${r.auth.type}`);
        console.log();
      }
      break;
    }
    case "browse": {
      const name = args[2];
      if (!name) { console.error("Usage: adk registry browse <name> [--query <q>]"); process.exit(1); }
      const query = getArg("--query");
      const agents = await adk.registry.browse(name, query);
      console.log(`\n${agents.length} agent(s)${query ? ` matching "${query}"` : ""}\n`);
      for (const a of agents) {
        const toolCount = a.tools?.length ?? 0;
        console.log(`  ${a.path} (${toolCount} tools)`);
        if (a.description) console.log(`    ${a.description.slice(0, 120)}`);
        console.log();
      }
      break;
    }
    case "inspect": {
      const name = args[2];
      if (!name) { console.error("Usage: adk registry inspect <name>"); process.exit(1); }
      const config = await adk.registry.inspect(name);
      console.log(`\nRegistry: ${name}\n`);
      console.log(`  issuer:       ${config.issuer}`);
      console.log(`  jwks_uri:     ${config.jwks_uri}`);
      console.log(`  token:        ${config.token_endpoint}`);
      console.log(`  grant_types:  ${config.supported_grant_types?.join(", ")}`);
      console.log();
      break;
    }
    case "test": {
      const name = args[2];
      const results = await adk.registry.test(name);
      for (const r of results) {
        const icon = r.status === "active" ? "\x1b[32m\u2713\x1b[0m" : "\x1b[31m\u2717\x1b[0m";
        console.log(`${icon} ${r.name} (${r.url})`);
        if (r.issuer) console.log(`  issuer: ${r.issuer}`);
        if (r.error) console.log(`  error: ${r.error}`);
      }
      break;
    }
    default:
      console.error(`Unknown registry operation: ${op}`);
      console.error("Operations: add, remove, list, browse, inspect, test");
      process.exit(1);
  }
}

// ============================================
// Ref CLI
// ============================================

async function runRef() {
  const op = args[1];
  const adk = getAdk();

  switch (op) {
    case "add": {
      const refArg = args[2];
      if (!refArg) { console.error("Usage: adk ref add <ref> [--registry <name>] [--as <alias>]"); process.exit(1); }
      const entry: Record<string, unknown> = { ref: refArg };
      const alias = getArg("--as");
      const url = getArg("--url");
      const scheme = getArg("--scheme");
      const registryName = getArg("--registry");
      if (alias) entry.as = alias;
      if (url) entry.url = url;
      if (scheme) entry.scheme = scheme;
      if (registryName) {
        const reg = await adk.registry.get(registryName);
        if (reg) {
          entry.sourceRegistry = { url: reg.url, agentPath: refArg };
        }
      }
      const { security } = await adk.ref.add(entry as import("./define-config.js").RefEntry);
      console.log(`Added ref: ${alias ?? refArg}`);
      if (security && security.type !== "none") {
        console.log(`\n  Auth required: ${security.type}`);
        console.log(`  Run: adk ref auth ${alias ?? refArg}`);
      }
      break;
    }
    case "remove": {
      const name = args[2];
      if (!name) { console.error("Usage: adk ref remove <name>"); process.exit(1); }
      const removed = await adk.ref.remove(name);
      console.log(removed ? `Removed: ${name}` : `Not found: ${name}`);
      break;
    }
    case "list": {
      const refs = await adk.ref.list();
      if (refs.length === 0) {
        console.log("No refs configured. Run: adk ref add <ref> --registry <name>");
        break;
      }
      console.log(`\n${refs.length} ref(s)\n`);
      for (const r of refs) {
        console.log(`  ${r.name}`);
        if (r.url) console.log(`    url: ${r.url}`);
        if (r.scheme) console.log(`    scheme: ${r.scheme}`);
        if (r.sourceRegistry) console.log(`    registry: ${r.sourceRegistry.url}`);
        console.log();
      }
      break;
    }
    case "get": {
      const name = args[2];
      if (!name) { console.error("Usage: adk ref get <name>"); process.exit(1); }
      const entry = await adk.ref.get(name);
      if (!entry) { console.error(`Not found: ${name}`); process.exit(1); }
      console.log(JSON.stringify(entry, null, 2));
      break;
    }
    case "inspect": {
      const name = args[2];
      if (!name) { console.error("Usage: adk ref inspect <name> [--full]"); process.exit(1); }
      const full = hasFlag("--full");
      const info = await adk.ref.inspect(name, { full });
      if (!info) { console.error(`Could not inspect: ${name}`); process.exit(1); }
      console.log(JSON.stringify(info, null, 2));
      break;
    }
    case "call": {
      const name = args[2];
      const tool = args[3];
      const paramsStr = args[4];
      if (!name || !tool) { console.error("Usage: adk ref call <name> <tool> [params_json]"); process.exit(1); }
      const params = paramsStr ? JSON.parse(paramsStr) : {};
      const result = await adk.ref.call(name, tool, params);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "resources": {
      const name = args[2];
      if (!name) { console.error("Usage: adk ref resources <name>"); process.exit(1); }
      const result = await adk.ref.resources(name);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "read": {
      const name = args[2];
      const uris = args.slice(3);
      if (!name || uris.length === 0) { console.error("Usage: adk ref read <name> <uri> [uri...]"); process.exit(1); }
      const result = await adk.ref.read(name, uris);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "auth-status": {
      const name = args[2];
      if (!name) { console.error("Usage: adk ref auth-status <name>"); process.exit(1); }
      const status = await adk.ref.authStatus(name);
      const icon = status.complete ? "\x1b[32m\u2713\x1b[0m" : "\x1b[33m!\x1b[0m";
      console.log(`\n${icon} ${status.name}`);
      console.log(`  auth type: ${status.security?.type ?? "none"}`);
      console.log(`  complete:  ${status.complete}`);
      if (status.present.length > 0) console.log(`  stored:    ${status.present.join(", ")}`);
      if (status.missing.length > 0) console.log(`  missing:   ${status.missing.join(", ")}`);
      console.log();
      break;
    }
    case "auth": {
      const name = args[2];
      if (!name) { console.error("Usage: adk ref auth <name> [--api-key <key>]"); process.exit(1); }
      const apiKey = getArg("--api-key");

      if (apiKey) {
        const result = await adk.ref.auth(name, { apiKey });
        if (result.complete) {
          console.log(`\x1b[32m\u2713\x1b[0m Auth complete for ${name} (${result.type})`);
        }
        break;
      }

      // Check what type of auth is needed
      const status = await adk.ref.authStatus(name);
      if (status.complete) {
        console.log(`\x1b[32m\u2713\x1b[0m ${name} is already authenticated`);
        break;
      }

      if (status.security?.type === "apiKey" || status.security?.type === "http") {
        console.error(`Provide a key: adk ref auth ${name} --api-key <your-key>`);
        process.exit(1);
      }

      // OAuth — run locally with browser open
      try {
        const result = await adk.ref.authLocal(name, {
          onAuthorizeUrl: (url) => {
            console.log(`\nOpen this URL to authorize:\n\n  ${url}\n`);
            const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
            import("node:child_process").then(({ exec }) => exec(`${opener} "${url}"`)).catch(() => {});
            console.log("Waiting for callback ...");
          },
        });
        if (result.complete) {
          console.log(`\x1b[32m\u2713\x1b[0m Auth complete for ${name}`);
        }
      } catch (err) {
        console.error(`Auth failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error(`Unknown ref operation: ${op}`);
      console.error("Operations: add, remove, list, get, inspect, call, resources, read, auth, auth-status");
      process.exit(1);
  }
}

// ============================================
// Main
// ============================================

switch (command) {
  case "registry":
    await runRegistry();
    break;
  case "ref":
    await runRef();
    break;
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
