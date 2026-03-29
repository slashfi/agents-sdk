/**
 * MCP Introspection
 *
 * Connects to an MCP server, introspects its tools,
 * and outputs a SerializedAgentDefinition (agent.json).
 *
 * Deduplicates shared $defs across tools.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface IntrospectOptions {
  server: string;
  name: string;
  out?: string;
  env?: Record<string, string>;
}

function deduplicateDefs(tools: Record<string, unknown>[]): {
  tools: Record<string, unknown>[];
  sharedDefs: Record<string, unknown>;
} {
  const defsByContent = new Map<string, { name: string; schema: unknown }>();

  for (const tool of tools) {
    const schema = tool.inputSchema as Record<string, unknown> | undefined;
    const defs = schema?.$defs;
    if (!defs || typeof defs !== "object") continue;
    for (const [defName, defSchema] of Object.entries(
      defs as Record<string, unknown>,
    )) {
      const key = JSON.stringify(defSchema);
      if (!defsByContent.has(key)) {
        defsByContent.set(key, { name: defName, schema: defSchema });
      }
    }
  }

  const sharedDefs: Record<string, unknown> = {};
  for (const { name, schema } of Array.from(defsByContent.values())) {
    sharedDefs[name] = schema;
  }

  const cleanedTools = tools.map((t) => {
    const schema = { ...(t.inputSchema as Record<string, unknown>) };
    schema.$defs = undefined;
    return { ...t, inputSchema: schema };
  });

  return { tools: cleanedTools, sharedDefs };
}

export async function introspectMcp(options: IntrospectOptions): Promise<void> {
  const { server, name, out } = options;

  const parts = server.split(/\s+/);
  const proc = spawn(parts[0], parts.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });

  let buffer = "";
  let messageId = 0;

  function sendJsonRpc(
    method: string,
    params: Record<string, unknown> = {},
  ): number {
    const id = ++messageId;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    proc.stdin?.write(`${msg}\n`);
    return id;
  }

  function waitForResponse(targetId: number): Promise<Record<string, unknown>> {
    return new Promise((res, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), 30000);
      const handler = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.id === targetId) {
              clearTimeout(timeout);
              proc.stdout?.removeListener("data", handler);
              if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
              else res(parsed.result);
            }
          } catch {
            /* ignore non-JSON */
          }
        }
      };
      proc.stdout?.on("data", handler);
    });
  }

  try {
    console.log(`Connecting to MCP server: ${server}`);

    const initId = sendJsonRpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "adk-introspect", version: "1.0.0" },
    });
    const initResult = (await waitForResponse(initId)) as Record<
      string,
      unknown
    >;
    const serverInfo = initResult.serverInfo as
      | Record<string, string>
      | undefined;
    console.log(`Server: ${serverInfo?.name} v${serverInfo?.version}`);

    proc.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );

    const toolsId = sendJsonRpc("tools/list", {});
    const toolsResult = (await waitForResponse(toolsId)) as Record<
      string,
      unknown
    >;
    const rawTools = (
      (toolsResult.tools || []) as Record<string, unknown>[]
    ).map((t) => ({
      name: t.name as string,
      description: (t.description as string) || "",
      inputSchema: (t.inputSchema as Record<string, unknown>) || {
        type: "object",
        properties: {},
      },
    }));
    console.log(`Discovered ${rawTools.length} tools`);

    const { tools, sharedDefs } = deduplicateDefs(rawTools);
    const defsCount = Object.keys(sharedDefs).length;
    if (defsCount > 0) {
      console.log(`Hoisted ${defsCount} shared $defs`);
    }

    const definition: Record<string, unknown> = {
      path: name,
      name: serverInfo?.name || name,
      description: `Agent for ${serverInfo?.name || name}`,
      version: serverInfo?.version || "1.0.0",
      visibility: "public",
      serverSource: server,
      serverInfo,
      ...(defsCount > 0 ? { $defs: sharedDefs } : {}),
      tools,
      generatedAt: new Date().toISOString(),
      sdkVersion: "0.22.0",
    };

    const outPath = out || `./${name}.json`;
    const resolved = resolve(outPath);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, `${JSON.stringify(definition, null, 2)}\n`);
    const sizeKB = (JSON.stringify(definition).length / 1024).toFixed(1);
    console.log(`\nWrote ${resolved} (${sizeKB}KB, ${tools.length} tools)`);
  } finally {
    proc.kill();
  }
}
