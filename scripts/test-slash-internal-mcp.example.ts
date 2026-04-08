/**
 * Smoke-test createRegistryConsumer against Slash internal MCP.
 *
 * Copy this file to `test-slash-internal-mcp.ts` (gitignored) and run from repo root:
 *
 *   doppler run -p server -c prd -- bun scripts/test-slash-internal-mcp.ts
 *
 * Manual / local override:
 *
 *   SLASH_ATLAS_API_KEY=... bun scripts/test-slash-internal-mcp.ts
 *
 * The server returns 401 without x-atlas-api-key.
 */

import {
  type RegistryConfiguration,
  createRegistryConsumer,
} from "@slashfi/agents-sdk";

const DEFAULT_MCP = "https://api.slash.com/internal/mcp";

/** Doppler `server` / prd; falls back to SLASH_ATLAS_API_KEY for ad-hoc runs. */
function resolveAtlasApiKey(): string | undefined {
  return process.env.ATLAS_INTERNAL_API_KEY ?? process.env.SLASH_ATLAS_API_KEY;
}

async function main() {
  const url = process.env.SLASH_MCP_URL ?? DEFAULT_MCP;
  const key = resolveAtlasApiKey();

  if (!key) {
    console.error(
      "No API key: set ATLAS_INTERNAL_API_KEY (e.g. via Doppler) or SLASH_ATLAS_API_KEY.",
    );
    console.error(`Target: ${url}`);
    process.exit(1);
  }

  const consumer = await createRegistryConsumer({
    registries: [
      {
        url,
        auth: {
          type: "api-key",
          key,
          header: "x-atlas-api-key",
        },
      },
    ],
    refs: [{ ref: "@legal-entities" }],
  });

  let discovery: RegistryConfiguration;
  try {
    discovery = await consumer.discover(url);
  } catch (e) {
    console.error("discover() failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log("discover() → issuer:", discovery.issuer);
  console.log("         token_endpoint:", discovery.token_endpoint);

  let agents: Awaited<ReturnType<typeof consumer.list>>;
  try {
    agents = await consumer.list();
    console.log(`list() → ${agents.length} agent(s)`);
    for (const a of agents.slice(0, 20)) {
      console.log(
        `  - ${a.path}${a.description ? `: ${a.description.slice(0, 80)}` : ""}`,
      );
    }
    if (agents.length > 20) {
      console.log(`  ... and ${agents.length - 20} more`);
    }
  } catch (e) {
    console.error("list() failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  const agentPath = "@legal-entities";
  try {
    const fromList = agents.find((a) => a.path === agentPath);
    const info = await consumer.inspect(agentPath);

    const listToolNames =
      fromList?.tools?.map((t) =>
        typeof t === "object" && t !== null && "name" in t
          ? String((t as { name: string }).name)
          : String(t),
      ) ?? [];

    const inspectToolNames =
      info?.tools?.map((t) =>
        typeof t === "object" && t !== null && "name" in t
          ? String((t as { name: string }).name)
          : String(t),
      ) ?? [];

    console.log(
      `\n${agentPath} (from list_agents) → ${listToolNames.length} tool(s)`,
    );
    for (const n of listToolNames.slice(0, 20)) {
      console.log(`  - ${n}`);
    }

    console.log(`inspect(${agentPath}) → ${inspectToolNames.length} tool(s)`);
    if (info?.description) {
      console.log("  description:", info.description.slice(0, 200));
    }
    for (const n of inspectToolNames.slice(0, 20)) {
      console.log(`  - ${n}`);
    }

    const toolName = listToolNames[0] ?? inspectToolNames[0] ?? null;

    if (!toolName) {
      console.log(
        "\nNo tool names from list/inspect — skipping execute_tool (agent may expose tools only after auth/context).",
      );
      return;
    }

    console.log(`\ncall(${agentPath}, "${toolName}", {}) …`);
    try {
      const out = await consumer.call(agentPath, toolName, {});
      console.log(
        "  result:",
        typeof out === "string"
          ? out.slice(0, 800)
          : JSON.stringify(out, null, 2).slice(0, 1200),
      );
    } catch (err) {
      console.log(
        "  (tool may require params —",
        err instanceof Error ? err.message : String(err),
        ")",
      );
    }
  } catch (e) {
    console.error(
      `inspect/call ${agentPath} failed:`,
      e instanceof Error ? e.message : e,
    );
    process.exit(1);
  }
}

main();
