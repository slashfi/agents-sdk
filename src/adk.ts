#!/usr/bin/env bun
/**
 * ADK CLI — Agent Development Kit
 *
 * Commands:
 *   init             Setup + skill injection for coding agents
 *   sync             Sync all refs and generate typed agent interfaces
 *   check <file>     Type-check a file with agent types (auto-injected)
 *   check -e "code"  Type-check inline code
 *   run <file>       Type-check + execute a file
 *   run -e "code"    Type-check + execute inline code
 *   registry <op>    Manage registry connections (add, remove, list, browse, inspect, test)
 *   ref <op>         Manage agent refs (add, remove, list, inspect, call, resources, read)
 *
 * @example
 * ```bash
 * adk registry add https://registry.slash.com --name public
 * adk registry browse public
 * adk ref add notion --registry public
 * adk ref inspect notion
 * adk ref call notion notion-search '{"query":"hello"}'
 * ```
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { createAdk } from "./config-store.js";
import { createLocalFsStore, getLocalEncryptionKey } from "./local-fs.js";
import type { Adk } from "./config-store.js";
import { AdkError, getError, getRecentErrors } from "./adk-error.js";
import { runInit, parseTarget } from "./init.js";
import { materializeRef, syncAllRefs } from "./materialize.js";
import { adkCheck } from "./adk-check.js";

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

function wantsHelp(): boolean {
  return args.includes("--help") || args.includes("-h");
}

const HELP_SECTIONS: Record<string, string> = {
  registry: `Registry operations:
  adk registry add <url> --name <name> [--auth-type bearer|api-key|none] [--proxy [--proxy-agent @config]]
  adk registry remove <name>
  adk registry list
  adk registry browse <name> [--query <q>]
  adk registry inspect <name>
  adk registry test [name]`,
  ref: `Ref operations:
  adk ref add <name>                     Install from default (public) registry
  adk ref add <name> --registry <reg>    Install from a specific registry
  adk ref add <name> --url <url>         Install from a direct URL
  adk ref remove <name>
  adk ref list
  adk ref inspect <name> [--full]
  adk ref call <name> <tool> [params_json]
  adk ref resources <name>
  adk ref read <name> <uri> [uri...]
  adk ref auth <name> [--api-key <key>] [--<field> <value> ...]
  adk ref auth-status <name>

Examples:
  adk ref add notion                     # Install from public registry
  adk ref add notion --registry internal # Install from "internal" registry
  adk ref add myapi --url https://api.example.com/mcp
  adk ref call notion notion-search '{"query":"hello"}'`,
};

function getAdk(): Adk {
  const token = process.env.ADK_TOKEN ?? undefined;
  const encryptionKey = getLocalEncryptionKey();
  return createAdk(createLocalFsStore(), { token, encryptionKey });
}

function printUsage() {
  console.log(`
adk — Agent Development Kit

Usage:
  adk init [--target <agent>:<path>]  Setup + install skills for coding agents
  adk sync [--ref <name>]             Materialize tool docs for all refs in config
  adk registry <op> [options]        Manage registry connections
  adk ref <op> [options]             Manage agent refs
  adk config-path                    Print config directory path
  adk error [id]                     View recent errors or a specific error

Registry operations:
  adk registry add <url> --name <name> [--auth-type bearer|api-key|none] [--proxy [--proxy-agent @config]]
  adk registry remove <name>
  adk registry list
  adk registry browse <name> [--query <q>]
  adk registry inspect <name>
  adk registry test [name]

Ref operations:
  adk ref add <ref> [--registry <name>] [--as <alias>] [--url <url>] [--scheme mcp|https|registry]
  adk ref remove <name>
  adk ref list
  adk ref inspect <name> [--full]
  adk ref call <name> <tool> [params_json]
  adk ref resources <name>
  adk ref read <name> <uri> [uri...]
  adk ref auth <name> [--api-key <key>] [--<field> <value> ...]
  adk ref auth-status <name>

Init targets (presets):
  claude            Claude Code skills (default: ~/.claude/skills)
  cursor            Cursor rules (default: .cursor/rules)
  copilot           GitHub Copilot instructions (default: .github)
  windsurf          Windsurf rules (default: .)
  codex             OpenAI Codex (default: .)
  hermes            Hermes skills (default: ~/.hermes/skills)

  Custom path: adk init --target <preset>:<path>

Environment:
  ADK_CONFIG_DIR        Config directory (default: ~/.adk)
  ADK_TOKEN             Bearer token for authenticated registries
  ADK_ENCRYPTION_KEY    Override encryption key (default: auto from ~/.adk/.encryption-key)

Examples:
  adk init --target claude --target cursor --target codex
  adk registry add https://registry.slash.com --name public
  adk registry browse public
  adk ref add notion --registry public
  adk ref inspect notion --full
  adk ref call notion notion-search '{"query":"hello"}'
`);
}

// ============================================
// Commands
// ============================================

// ============================================
// Registry CLI
// ============================================

async function runRegistry() {
  if (wantsHelp()) { console.log(HELP_SECTIONS.registry); process.exit(0); }
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
        const toolCount = a.toolCount ?? 0;
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
  if (wantsHelp()) { console.log(HELP_SECTIONS.ref); process.exit(0); }
  const op = args[1];
  const adk = getAdk();

  switch (op) {
    case "add": {
      const refArg = args[2];
      if (!refArg) { console.error("Usage: adk ref add <ref> [--registry <name>] [--as <alias>]"); process.exit(1); }
      const entry: Record<string, unknown> = { ref: refArg };
      const alias = getArg("--as");
      const url = getArg("--url");
      const registryName = getArg("--registry");
      // Auto-detect: if no --registry and no --url, try default registry
      const effectiveRegistry = registryName ?? (url ? undefined : "public");
      const scheme = getArg("--scheme") ?? (effectiveRegistry ? "registry" : undefined);
      if (alias) entry.as = alias;
      if (url) entry.url = url;
      if (scheme) entry.scheme = scheme;
      if (effectiveRegistry) {
        const reg = await adk.registry.get(effectiveRegistry);
        if (reg) {
          entry.sourceRegistry = { url: reg.url, agentPath: refArg };
        }
      }
      try {
        const { security } = await adk.ref.add(entry as import("./define-config.js").RefEntry);
        console.log(`Added ref: ${alias ?? refArg}`);
        if (security && security.type !== "none") {
          console.log(`\n  Auth required: ${security.type}`);
          console.log(`  Run: adk ref auth ${alias ?? refArg}`);
        }

        // Materialize local docs
        const configDir = process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk");
        const refDisplayName = alias ?? refArg;
        try {
          const result = await materializeRef(adk, refDisplayName, configDir);
          if (result.toolCount > 0) {
            console.log(`\x1b[32m\u2713\x1b[0m Materialized ${result.toolCount} tool schemas`);
          }
          if (result.skillCount > 0) {
            console.log(`\x1b[32m\u2713\x1b[0m Downloaded ${result.skillCount} skill files`);
          }
          if (result.typesGenerated) {
            console.log(`\x1b[32m\u2713\x1b[0m Generated TypeScript types`);
          }

          // Per-ref skills removed — refs are discovered via refs/<name>/ in config dir
          const config = await adk.readConfig();
          const targets = (config as any).targets as string[] | undefined;
          if (!targets || targets.length === 0) {
            console.log(`\nRun \`adk init\` to install skills for your coding agents.`);
          }
        } catch {
          // Materialization is best-effort, don't fail the ref add
        }
      } catch (err) {
        if (err instanceof AdkError) {
          console.error(err.toAgentString());
          process.exit(1);
        }
        throw err;
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
      for (const [field, info] of Object.entries(status.fields)) {
        const fieldIcon = info.present ? "\x1b[32m\u2713\x1b[0m"
          : info.resolvable ? "\x1b[36m\u2192\x1b[0m"
          : info.automated ? "\x1b[33m~\x1b[0m"
          : "\x1b[31m\u2717\x1b[0m";
        const source = info.present ? "stored"
          : info.resolvable ? "resolvable"
          : info.automated ? "automated"
          : "missing";
        console.log(`  ${fieldIcon} ${field}: ${source}${info.required ? "" : " (optional)"}`);
      }
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

      // authLocal handles both OAuth (browser redirect) and apiKey/http (local credential form)
      try {
        const result = await adk.ref.authLocal(name, {
          onAuthorizeUrl: (url) => {
            console.log(`\nOpen this URL to authenticate:\n\n  ${url}\n`);
            const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
            import("node:child_process").then(({ exec }) => exec(`${opener} "${url}"`)).catch(() => {});
            console.log("Waiting ...");
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
      console.error("Operations: add, remove, list, inspect, call, resources, read, auth, auth-status");
      process.exit(1);
  }
}

// ============================================
// Main
// ============================================

switch (command) {
  case "init": {
    const adk = getAdk();
    const targets = args
      .slice(1)
      .filter((_, i, arr) => i > 0 && arr[i - 1] === "--target")
      .concat(
        // Also grab positional --target values
        args.reduce<string[]>((acc, arg, i) => {
          if (arg === "--target" && args[i + 1]) acc.push(args[i + 1]);
          return acc;
        }, []),
      )
      // Deduplicate
      .filter((v, i, a) => a.indexOf(v) === i)
      .map(parseTarget);
    await runInit(adk, targets);
    break;
  }
  case "sync": {
    const adk = getAdk();
    const configDir = process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk");
    const filter = getArg("--ref");
    console.log(filter ? `Syncing ref: ${filter}` : "Syncing all refs from config...");
    const syncResult = await syncAllRefs(adk, configDir, {
      filter: filter ?? undefined,
      onProgress(name, status) {
        console.log(`  ${name}: ${status}`);
      },
    });
    const ok = syncResult.refs.filter((r) => !r.error);
    const failed = syncResult.refs.filter((r) => r.error);
    console.log(`\n\x1b[32m✓\x1b[0m Synced ${ok.length} ref(s): ${syncResult.totalTools} tools, ${syncResult.totalSkills} skills`);
    if (failed.length > 0) {
      console.log(`\x1b[33m!\x1b[0m ${failed.length} ref(s) failed:`);
      for (const f of failed) console.log(`    ${f.name}: ${f.error}`);
    }
    console.log(`\nDocs written to: ${configDir}/refs/`);
    break;
  }
  case "config-path": {
    const dir = process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk");
    console.log(dir);
    break;
  }
  case "error": {
    const errorId = args[1];
    if (!errorId) {
      const errors = getRecentErrors();
      if (errors.length === 0) { console.log("No recent errors."); break; }
      console.log(`\n${errors.length} recent error(s)\n`);
      for (const e of errors.slice(-10)) {
        console.log(`  ${e.errorId} [${e.code}] ${e.message}`);
      }
      console.log();
    } else {
      const err = getError(errorId);
      if (!err) { console.error(`Error not found: ${errorId}`); process.exit(1); }
      console.log(err.toDebugString());
    }
    break;
  }
  case "registry":
    await runRegistry();
    break;
  case "ref":
    await runRef();
    break;
  case "check":
  case "run": {
    const isRun = command === "run";
    const noCheck = hasFlag("--no-check");
    const eFlag = args.indexOf("-e");
    const file = eFlag === -1 ? args.filter(a => a !== "--no-check")[1] : undefined;
    const code = eFlag !== -1 ? args[eFlag + 1] : undefined;
    if (!file && !code) {
      console.error(`Usage: adk ${command} <file> | adk ${command} -e "<code>"`);
      process.exit(1);
    }
    const result = await adkCheck({ file, code, run: isRun, noCheck });
    process.exit(result.exitCode);
  }
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
