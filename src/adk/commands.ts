/**
 * ADK Consumer Commands — init, search, add, remove, info, call, list, serve, login
 *
 * These are the consumer-facing commands. The builder commands (codegen, introspect,
 * pack, publish, use) already exist in adk.ts.
 */

import { createInterface } from "node:readline";
import {
  initAdkDir,
  readConfig,
  isInitialized,
  addRef,
  removeRef,
  removeSecrets,
  listRefs,
  setSecret,
  getSecret,
  listSecretKeys,
} from "./local-store.js";
import { McpRegistryClient } from "./mcp-client.js";

// ============================================
// Helpers
// ============================================

function ensureInit(): void {
  if (!isInitialized()) {
    console.error("adk is not initialized. Run 'adk init' first.");
    process.exit(1);
  }
}

function getClient(): McpRegistryClient {
  const config = readConfig();
  const urls = (config.registries ?? []).map((r) =>
    typeof r === "string" ? r : r.url,
  );
  if (urls.length === 0) {
    console.error("No registries configured. Run 'adk init' or edit ~/adk/config.json.");
    process.exit(1);
  }
  return new McpRegistryClient(urls);
}

async function promptSecret(question: string): Promise<string> {
  // Write prompt to stderr so it doesn't pollute stdout
  process.stderr.write(question);
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      rl.close();
      process.stderr.write("\n");
      resolve(line.trim());
    });
  });
}

// ============================================
// Commands
// ============================================

/**
 * adk init [--registry <url>] [--force]
 */
export async function cmdInit(args: string[]): Promise<void> {
  const registry = getArg(args, "--registry");
  const force = args.includes("--force");

  const { dir, created } = await initAdkDir({ registry, force });

  console.log(`\n✓ Initialized ${dir}`);
  if (created.config) console.log("  Created config.json");
  if (created.secrets) console.log("  Created secrets.json");
  if (created.key) console.log("  Created .key (0600)");

  if (!created.config && !created.secrets && !created.key) {
    console.log("  Already initialized (use --force to overwrite)");
  }

  const config = readConfig();
  const registries = (config.registries ?? []).map((r) =>
    typeof r === "string" ? r : r.url,
  );
  console.log(`\nRegistries:`);
  for (const r of registries) {
    console.log(`  ${r}`);
  }
  console.log();
}

/**
 * adk search [query]
 */
export async function cmdSearch(args: string[]): Promise<void> {
  ensureInit();
  const query = args.filter((a) => !a.startsWith("--")).join(" ") || undefined;
  const client = getClient();

  console.log(query ? `Searching for "${query}"...\n` : "Listing all agents...\n");

  const results = await client.search(query);

  let totalAgents = 0;
  for (const { agents, registry } of results) {
    if (agents.length === 0) continue;
    console.log(`│ ${registry}`);
    console.log(`│`);
    for (const agent of agents) {
      const toolCount = agent.tools.length;
      console.log(`│  ${agent.name.padEnd(20)} ${String(toolCount).padStart(3)} tools  ${agent.description ?? ""}`);
      totalAgents++;
    }
    console.log();
  }

  if (totalAgents === 0) {
    console.log("No agents found.");
  } else {
    console.log(`${totalAgents} agent(s) found. Run 'adk add <agent>' to add one.`);
  }
}

/**
 * adk add <agent> [--as <alias>]
 */
export async function cmdAdd(args: string[]): Promise<void> {
  ensureInit();

  const agentName = args[0];
  if (!agentName || agentName.startsWith("--")) {
    console.error("Usage: adk add <agent> [--as <alias>]");
    process.exit(1);
  }

  const alias = getArg(args, "--as") ?? agentName;
  const client = getClient();

  // Fetch agent detail
  console.log(`Fetching ${agentName}...`);
  const result = await client.getAgent(agentName);
  if (!result) {
    console.error(`Agent '${agentName}' not found on any configured registry.`);
    console.error("Run 'adk search' to see available agents.");
    process.exit(1);
  }

  const { agent, registry } = result;
  console.log(`Found: ${agent.name} (${agent.tools.length} tools) from ${registry}`);

  // For now, prompt for API key if this looks like an integration
  // TODO: registry should expose security scheme via MCP metadata
  const needsCreds = await promptSecret(`\nDoes ${agent.name} require credentials? Enter API key (or press Enter to skip): `);
  if (needsCreds) {
    await setSecret(alias, "apiKey", needsCreds);
    console.log("\n✓ Credentials saved (encrypted)");
  }

  // Add ref to config
  const refEntry = alias !== agentName
    ? { ref: agentName, as: alias }
    : agentName;
  addRef(refEntry);

  console.log(`✓ Added ${alias} to config.json`);
  console.log(`\nReady! Try: adk call ${alias} --help`);
}

/**
 * Handle OAuth2 flow with localhost callback server.
 */
export async function cmdRemove(args: string[]): Promise<void> {
  ensureInit();

  const name = args[0];
  if (!name) {
    console.error("Usage: adk remove <agent>");
    process.exit(1);
  }

  const removed = removeRef(name);
  removeSecrets(name);

  if (removed) {
    console.log(`✓ Removed ${name} (ref + secrets)`);
  } else {
    console.error(`Agent '${name}' not found in config.`);
    process.exit(1);
  }
}

/**
 * adk info <agent>
 */
export async function cmdInfo(args: string[]): Promise<void> {
  ensureInit();

  const name = args[0];
  if (!name) {
    console.error("Usage: adk info <agent>");
    process.exit(1);
  }

  const client = getClient();
  const result = await client.getAgent(name);

  if (!result) {
    console.error(`Agent '${name}' not found on any configured registry.`);
    process.exit(1);
  }

  const { agent, registry } = result;

  console.log(`\n${agent.name}`);
  if (agent.description) console.log(`  ${agent.description}`);
  console.log(`  Registry: ${registry}`);

  // Check if locally configured
  const secrets = listSecretKeys(name);
  if (secrets.length > 0) {
    console.log(`  Local credentials: ${secrets.join(", ")}`);
  }

  console.log(`\nTools (${agent.tools.length}):`);
  for (const tool of agent.tools) {
    console.log(`  ${tool.name}`);
    if (tool.description) console.log(`    ${tool.description}`);
    if (tool.inputSchema) {
      const schema = tool.inputSchema as any;
      const props = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const paramNames = Object.keys(props);
      if (paramNames.length > 0) {
        for (const p of paramNames) {
          const req = required.has(p) ? "*" : " ";
          const type = props[p].type ?? "any";
          const desc = props[p].description ?? "";
          console.log(`    ${req} ${p}: ${type}${desc ? " \u2014 " + desc : ""}`);
        }
      }
    }
  }
  console.log();
}
export async function cmdCall(args: string[]): Promise<void> {
  ensureInit();

  const agentName = args[0];
  const toolName = args[1];

  if (!agentName) {
    console.error("Usage: adk call <agent> <tool> [json]");
    process.exit(1);
  }

  // If only agent name, show help (list tools)
  if (!toolName || toolName === "--help") {
    await cmdInfo([agentName]);
    return;
  }

  // Parse params
  let params: Record<string, unknown> = {};
  const jsonArg = args[2];
  if (jsonArg) {
    try {
      params = JSON.parse(jsonArg);
    } catch {
      console.error(`Invalid JSON: ${jsonArg}`);
      process.exit(1);
    }
  }

  // Load credentials
  const credentials: Record<string, string> = {};
  const secretKeys = listSecretKeys(agentName);
  for (const key of secretKeys) {
    const value = await getSecret(agentName, key);
    if (value) credentials[key] = value;
  }

  const client = getClient();

  try {
    const result = await client.callTool(agentName, toolName, params, credentials);
    // Output result as JSON to stdout (for piping)
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * adk list — show configured agents + codegen'd agents
 */
export async function cmdListConsumer(_args: string[]): Promise<void> {
  if (!isInitialized()) {
    console.log("adk is not initialized. Run 'adk init' first.\n");
    return;
  }

  const refs = listRefs();

  if (refs.length === 0) {
    console.log("No agents configured. Run 'adk search' and 'adk add <agent>' to get started.\n");
    return;
  }

  console.log("\nYour agents:\n");
  for (const { name, ref, hasSecrets } of refs) {
    const alias = name !== ref ? ` (${ref})` : "";
    const creds = hasSecrets ? " 🔑" : "";
    console.log(`  ${name}${alias}${creds}`);
  }
  console.log();
}

/**
 * adk serve — start local MCP server exposing all configured agents
 */
export async function cmdServe(args: string[]): Promise<void> {
  ensureInit();

  const port = Number(getArg(args, "--port") ?? "3456");
  const refs = listRefs();

  if (refs.length === 0) {
    console.error("No agents configured. Run 'adk add <agent>' first.");
    process.exit(1);
  }

  console.log(`\nStarting MCP server on port ${port}...`);
  console.log(`Exposing ${refs.length} agent(s):\n`);
  for (const { name } of refs) {
    console.log(`  ✓ ${name}`);
  }

  const client = getClient();

  // Build tool list from all agents
  const allTools: Array<{
    agentName: string;
    agentPath: string;
    toolName: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }> = [];

  for (const { name } of refs) {
    const result = await client.getAgent(name);
    if (result) {
      for (const tool of result.agent.tools) {
        allTools.push({
          agentName: name,
          agentPath: result.agent.path,
          toolName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
  }

  console.log(`\n${allTools.length} tools available.`);

  // MCP-compatible JSON-RPC server
  // @ts-expect-error server used to keep process alive
  const server = Bun.serve({
    port,
    async fetch(req) {
      if (req.method !== "POST") {
        // GET /tools/list for discovery
        if (req.method === "GET" && new URL(req.url).pathname === "/tools/list") {
          return Response.json({
            tools: allTools.map((t) => ({
              name: `${t.agentName}__${t.toolName}`,
              description: `[${t.agentName}] ${t.description ?? t.toolName}`,
              inputSchema: t.inputSchema ?? { type: "object", properties: {} },
            })),
          });
        }
        return new Response("MCP server. POST JSON-RPC to call tools.", { status: 200 });
      }

      const body = (await req.json()) as any;

      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: allTools.map((t) => ({
              name: `${t.agentName}__${t.toolName}`,
              description: `[${t.agentName}] ${t.description ?? t.toolName}`,
              inputSchema: t.inputSchema ?? { type: "object", properties: {} },
            })),
          },
        });
      }

      if (body.method === "tools/call") {
        const fullName = body.params?.name as string;
        const args = body.params?.arguments ?? {};

        // Parse agent__tool format
        const sep = fullName.indexOf("__");
        if (sep === -1) {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32602, message: `Tool name must be agent__tool format, got: ${fullName}` },
          });
        }

        const agentName = fullName.substring(0, sep);
        const toolName = fullName.substring(sep + 2);

        // Load credentials
        const credentials: Record<string, string> = {};
        const secretKeys = listSecretKeys(agentName);
        for (const key of secretKeys) {
          const value = await getSecret(agentName, key);
          if (value) credentials[key] = value;
        }

        try {
          const result = await client.callTool(agentName, toolName, args, credentials);
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result,
          });
        } catch (err) {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: -32000,
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `Unknown method: ${body.method}` },
      });
    },
  });

  console.log(`\n▸ MCP server running at http://localhost:${port}`);
  console.log(`  Connect any MCP client to use your agents.`);
  console.log(`  Press Ctrl+C to stop.\n`);

  // Keep alive
  await new Promise(() => {});
}

/**
 * adk login — authenticate with registry for publishing
 */
export async function cmdLogin(args: string[]): Promise<void> {
  ensureInit();

  const config = readConfig();
  const registryUrl = getArg(args, "--registry")
    ?? (typeof config.registries?.[0] === "string" ? config.registries[0] : config.registries?.[0]?.url)
    ?? "https://registry.slash.com";

  console.log(`Logging in to ${registryUrl}...\n`);

  // For now, simple token-based auth
  const token = await promptSecret("API token: ");
  if (!token) {
    console.error("No token provided.");
    process.exit(1);
  }

  await setSecret("__registry__", registryUrl, token);
  console.log(`\n✓ Logged in to ${registryUrl}`);
}

// ============================================
// Arg Helpers
// ============================================

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}
