/**
 * MCP Codegen
 *
 * Connects to any MCP server, introspects its tools via `tools/list`,
 * and generates readable agent-definition source files.
 *
 * Supports three transport modes:
 * - stdio: spawn a process (e.g., `npx @modelcontextprotocol/server-notion`)
 * - sse: connect to an SSE endpoint
 * - http: connect to an HTTP JSON-RPC endpoint
 *
 * @example
 * ```typescript
 * import { codegen } from '@slashfi/agents-sdk';
 *
 * await codegen({
 *   server: 'npx @modelcontextprotocol/server-notion',
 *   outDir: './generated/notion',
 *   agentPath: '@notion',
 * });
 * ```
 *
 * @example CLI
 * ```bash
 * agents-sdk codegen --server 'npx @mcp/notion' --name notion
 * agents-sdk use notion search_pages '{"query": "hello"}'
 * agents-sdk use notion --list
 * ```
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonSchema } from "./types.js";

// ============================================
// Types
// ============================================

/** MCP tool definition as returned by tools/list */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

/** MCP server info from initialize response */
export interface McpServerInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

/** Transport for communicating with an MCP server */
export interface McpTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Send a JSON-RPC notification (no id, no response expected) */
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/** Server source — string command, URL, or explicit config */
export type ServerSource =
  | string
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> }
  | { spawn: string; args?: string[]; env?: Record<string, string>; port?: number; endpoint?: string };

/** Options for the codegen function */
export interface CodegenOptions {
  /** MCP server source — command string, URL, or config object */
  server: ServerSource;

  /** Output directory for generated files */
  outDir: string;

  /** Agent path override (default: derived from server name) */
  agentPath?: string;

  /** Agent display name */
  name?: string;

  /** SDK import path (default: '@slashfi/agents-sdk') */
  sdkImport?: string;

  /** Whether to generate a CLI entrypoint (default: true) */
  cli?: boolean;

  /** Whether to generate TypeScript interfaces from schemas (default: true) */
  types?: boolean;

  /** Visibility for the generated agent (default: 'public') */
  visibility?: "public" | "internal" | "private";
}

/** Result of codegen */
export interface CodegenResult {
  /** Path to the output directory */
  outDir: string;

  /** Server info from the MCP initialize handshake */
  serverInfo: McpServerInfo;

  /** Number of tools generated */
  toolCount: number;

  /** Names of generated tool files */
  toolFiles: string[];

  /** All generated file paths */
  files: string[];
}

// ============================================
// Protocol Constants
// ============================================

const LATEST_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

// ============================================
// Safe Environment (security)
// ============================================

/** Only inherit safe env vars when spawning MCP servers (prevents secret leakage). */
const DEFAULT_INHERITED_ENV_VARS =
  process.platform === "win32"
    ? [
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
        "PROGRAMFILES",
      ]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

function getDefaultEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process.env[key];
    if (value === undefined || value.startsWith("()")) continue;
    env[key] = value;
  }
  return env;
}

// ============================================
// Transport: stdio
// ============================================

import spawn from "cross-spawn";
import { spawn as nodeSpawn } from "node:child_process";

function createStdioTransport(source: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): McpTransport {
  // Use cross-spawn for Windows compatibility (.cmd/.bat wrappers, spaces in paths)
  // Env: if explicit env provided, use safe defaults + explicit. Otherwise inherit process.env.
  const env = source.env
    ? { ...getDefaultEnvironment(), ...source.env }
    : { ...process.env } as Record<string, string>;
  const proc = spawn(source.command, source.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  let requestId = 0;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  // Error handlers for pipes (prevent unhandled errors)
  proc.on("error", (err) => {
    for (const [id, p] of pending) {
      p.reject(new Error(`Process error: ${err.message}`));
      pending.delete(id);
    }
  });
  proc.stdin?.on("error", () => { /* ignore broken pipe */ });
  proc.stdout?.on("error", () => { /* ignore */ });
  proc.stderr?.on("error", () => { /* ignore */ });

  // Read stdout with Content-Length framing (MCP spec) or newline-delimited fallback
  let buffer = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();

    // Try to parse messages from buffer
    while (buffer.length > 0) {
      // Check for Content-Length framing (MCP standard)
      const clMatch = buffer.match(
        /^Content-Length:\s*(\d+)\r?\n(?:[^\r\n]+\r?\n)*\r?\n/,
      );
      if (clMatch) {
        const contentLength = parseInt(clMatch[1], 10);
        const headerEnd = clMatch[0].length;
        if (buffer.length >= headerEnd + contentLength) {
          const body = buffer.slice(headerEnd, headerEnd + contentLength);
          buffer = buffer.slice(headerEnd + contentLength);
          try {
            const msg = JSON.parse(body);
            if (msg.id !== undefined && pending.has(msg.id)) {
              const p = pending.get(msg.id)!;
              pending.delete(msg.id);
              if (msg.error) {
                p.reject(
                  new Error(
                    `MCP error ${msg.error.code}: ${msg.error.message}`,
                  ),
                );
              } else {
                p.resolve(msg.result);
              }
            }
          } catch {
            // malformed JSON, skip
          }
          continue;
        }
        // Not enough data yet, wait for more
        break;
      }

      // Fallback: newline-delimited JSON
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) break;

      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) {
            p.reject(
              new Error(
                `MCP error ${msg.error.code}: ${msg.error.message}`,
              ),
            );
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // ignore non-JSON lines (e.g., server logs)
      }
    }
  });

  return {
    async send(method: string, params?: Record<string, unknown>) {
      const id = ++requestId;
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? {},
      });

      // Send as newline-delimited JSON (compatible with all MCP SDK versions)
      proc.stdin!.write(message + "\n");

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, 30_000);

        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timeout);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timeout);
            reject(e);
          },
        });
      });
    },
    async notify(method: string, params?: Record<string, unknown>) {
      // Notification = no id field, no response expected
      const message = JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params ? { params } : {}),
      });
      proc.stdin!.write(message + "\n");
    },
    async close() {
      // Graceful shutdown: stdin.end → wait → SIGTERM → wait → SIGKILL
      const closePromise = new Promise<void>((resolve) => {
        proc.once("close", () => resolve());
      });

      try { proc.stdin?.end(); } catch { /* ignore */ }
      await Promise.race([closePromise, new Promise((r) => setTimeout(r, 2000))]);

      if (proc.exitCode === null) {
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        await Promise.race([closePromise, new Promise((r) => setTimeout(r, 2000))]);
      }

      if (proc.exitCode === null) {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      }
    },
  };
}

// ============================================
// Transport: HTTP JSON-RPC (Streamable HTTP)
// ============================================

function createHttpTransport(source: {
  url: string;
  headers?: Record<string, string>;
}): McpTransport {
  let requestId = 0;
  let sessionId: string | null = null;

  return {
    async send(method: string, params?: Record<string, unknown>) {
      const id = ++requestId;
      const res = await fetch(source.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          ...source.headers,
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: params ?? {},
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }

      // Capture session ID if returned
      const newSessionId = res.headers.get("mcp-session-id");
      if (newSessionId) sessionId = newSessionId;

      const contentType = res.headers.get("content-type") ?? "";

      // Handle SSE-wrapped responses (Streamable HTTP)
      if (contentType.includes("text/event-stream")) {
        const text = await res.text();
        // Parse SSE: look for "data: {...}" lines
        for (const line of text.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              const msg = JSON.parse(line.slice(6));
              if (msg.error) {
                throw new Error(
                  `MCP error ${msg.error.code}: ${msg.error.message}`,
                );
              }
              return msg.result;
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }
        throw new Error("No JSON-RPC response found in SSE stream");
      }

      // Standard JSON response
      const msg = (await res.json()) as {
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (msg.error) {
        throw new Error(
          `MCP error ${msg.error.code}: ${msg.error.message}`,
        );
      }
      return msg.result;
    },
    async notify(method: string, params?: Record<string, unknown>) {
      // Send notification (no id, accept 202 Accepted)
      const res = await fetch(source.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          ...source.headers,
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          ...(params ? { params } : {}),
        }),
      });
      // 202 Accepted is expected for notifications
      if (!res.ok && res.status !== 202) {
        await res.text().catch(() => {});
      }
    },
    async close() {
      // nothing to close for HTTP
    },
  };
}

// ============================================
// Transport: SSE (legacy MCP SSE protocol)
// ============================================

function createSseTransport(source: {
  url: string;
  headers?: Record<string, string>;
}): McpTransport {
  let postEndpoint: string | null = null;
  let requestId = 0;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let sseController: ReadableStreamDefaultReader | null = null;

  // Connect to SSE and discover the POST endpoint
  const connectPromise = (async () => {
    const res = await fetch(source.url, {
      headers: {
        Accept: "text/event-stream",
        ...source.headers,
      },
    });

    if (!res.ok) {
      throw new Error(`SSE connect failed: ${res.status} ${await res.text()}`);
    }

    const reader = res.body!.getReader();
    sseController = reader;
    const decoder = new TextDecoder();
    let buffer = "";

    // Read SSE events in background
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE events
          while (buffer.includes("\n\n")) {
            const eventEnd = buffer.indexOf("\n\n");
            const eventText = buffer.slice(0, eventEnd);
            buffer = buffer.slice(eventEnd + 2);

            let eventType = "message";
            let eventData = "";

            for (const line of eventText.split("\n")) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                eventData += line.slice(6);
              }
            }

            if (eventType === "endpoint" && eventData) {
              // Resolve relative URLs
              const base = new URL(source.url);
              postEndpoint = eventData.startsWith("http")
                ? eventData
                : `${base.origin}${eventData}`;
            } else if (eventType === "message" && eventData) {
              try {
                const msg = JSON.parse(eventData);
                if (msg.id !== undefined && pending.has(msg.id)) {
                  const p = pending.get(msg.id)!;
                  pending.delete(msg.id);
                  if (msg.error) {
                    p.reject(
                      new Error(
                        `MCP error ${msg.error.code}: ${msg.error.message}`,
                      ),
                    );
                  } else {
                    p.resolve(msg.result);
                  }
                }
              } catch {
                // ignore malformed JSON
              }
            }
          }
        }
      } catch {
        // stream closed
      }
    })();

    // Wait for endpoint to be discovered
    const deadline = Date.now() + 10_000;
    while (!postEndpoint && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!postEndpoint) {
      throw new Error("SSE endpoint not discovered within timeout");
    }
  })();

  return {
    async send(method: string, params?: Record<string, unknown>) {
      await connectPromise;

      const id = ++requestId;
      const res = await fetch(postEndpoint!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...source.headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: params ?? {},
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      // Response may come via SSE stream or directly
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const msg = (await res.json()) as {
          result?: unknown;
          error?: { code: number; message: string };
        };
        if (msg.error) {
          throw new Error(
            `MCP error ${msg.error.code}: ${msg.error.message}`,
          );
        }
        return msg.result;
      }

      // Otherwise wait for response via SSE stream
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP SSE request timed out: ${method}`));
        }, 30_000);

        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timeout);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timeout);
            reject(e);
          },
        });
      });
    },
    async close() {
      if (sseController) {
        await sseController.cancel().catch(() => {});
      }
    },
    async notify(method: string, params?: Record<string, unknown>) {
      await connectPromise;
      await fetch(postEndpoint!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...source.headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          ...(params ? { params } : {}),
        }),
      }).catch(() => {});
    },
  };
}

// ============================================
// Source Parsing
// ============================================

function parseServerSource(source: ServerSource): McpTransport {
  if (typeof source === "string") {
    // URL -> HTTP or SSE transport
    if (source.startsWith("http://") || source.startsWith("https://")) {
      // URLs ending in /sse use SSE transport
      if (source.endsWith("/sse")) {
        return createSseTransport({ url: source });
      }
      return createHttpTransport({ url: source });
    }
    // Command string -> stdio transport
    const parts = source.split(/\s+/);
    return createStdioTransport({
      command: parts[0],
      args: parts.slice(1),
    });
  }

  if ("url" in source) {
    // URLs ending in /sse use SSE transport
    if (source.url.endsWith("/sse")) {
      return createSseTransport(source);
    }
    return createHttpTransport(source);
  }

  if ("spawn" in source) {
    return createSpawnHttpTransport(source);
  }

  return createStdioTransport(source);
}

// ============================================
// Transport: Spawn + HTTP (for servers needing a port)
// ============================================

function createSpawnHttpTransport(source: {
  spawn: string;
  args?: string[];
  env?: Record<string, string>;
  port?: number;
  endpoint?: string;
}): McpTransport {
  const port = source.port ?? Math.floor(40000 + Math.random() * 10000);
  const endpoint = source.endpoint ?? "/mcp";
  const args = [...(source.args ?? []), "--port", String(port)];

  const spawnEnv = source.env
    ? { ...getDefaultEnvironment(), ...source.env }
    : { ...process.env } as Record<string, string>;
  const proc = Bun.spawn([source.spawn, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv,
  });

  // Create inner HTTP transport
  const inner = createHttpTransport({ url: `http://127.0.0.1:${port}${endpoint}` });

  // Wait for server to be ready
  const readyPromise = (async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(1000),
        });
        // Any response (even 400) means server is up
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`Server failed to start on port ${port} within 15s`);
  })();

  return {
    async send(method: string, params?: Record<string, unknown>) {
      await readyPromise;
      return inner.send(method, params);
    },
    async notify(method: string, params?: Record<string, unknown>) {
      await readyPromise;
      return inner.notify(method, params);
    },
    async close() {
      await inner.close();
      proc.kill();
    },
  };
}

// ============================================
// Code Generation Helpers
// ============================================

/** Convert tool name to a valid TypeScript identifier (camelCase) */
function toIdentifier(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .split("_")
    .filter(Boolean)
    .map((part, i) =>
      i === 0
        ? part.toLowerCase()
        : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join("");
}

/** Convert tool name to PascalCase for type names */
function toPascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

/** Convert tool name to kebab-case for file names */
function toKebabCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** Serialize a JSON schema to a readable TypeScript literal string */
function schemaToString(schema: JsonSchema, indent = 4): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];

  lines.push("{");
  lines.push(`${pad}type: '${schema.type}' as const,`);

  if (schema.description) {
    lines.push(
      `${pad}description: ${JSON.stringify(schema.description)},`,
    );
  }

  if (schema.enum) {
    lines.push(`${pad}enum: ${JSON.stringify(schema.enum)},`);
  }

  if (schema.properties) {
    lines.push(`${pad}properties: {`);
    for (const [key, prop] of Object.entries(schema.properties)) {
      const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
      lines.push(
        `${pad}  ${safeKey}: ${schemaToString(prop as JsonSchema, indent + 4)},`,
      );
    }
    lines.push(`${pad}},`);
  }

  if (schema.items) {
    lines.push(
      `${pad}items: ${schemaToString(schema.items as JsonSchema, indent + 2)},`,
    );
  }

  if (schema.required && schema.required.length > 0) {
    lines.push(
      `${pad}required: [${schema.required.map((r) => `'${r}'`).join(", ")}] as const,`,
    );
  }

  if (schema.additionalProperties !== undefined) {
    if (typeof schema.additionalProperties === "boolean") {
      lines.push(
        `${pad}additionalProperties: ${schema.additionalProperties},`,
      );
    } else {
      lines.push(
        `${pad}additionalProperties: ${schemaToString(schema.additionalProperties as JsonSchema, indent + 2)},`,
      );
    }
  }

  if (schema.default !== undefined) {
    lines.push(`${pad}default: ${JSON.stringify(schema.default)},`);
  }

  lines.push(`${" ".repeat(indent - 2)}}`);
  return lines.join("\n");
}

/** Generate a TypeScript interface from a JSON Schema */
function schemaToInterface(
  name: string,
  schema: JsonSchema,
): string {
  if (schema.type !== "object" || !schema.properties) {
    return `export type ${name} = unknown;`;
  }

  const required = new Set(schema.required ?? []);
  const lines: string[] = [`export interface ${name} {`];

  for (const [key, prop] of Object.entries(schema.properties)) {
    const p = prop as JsonSchema;
    const optional = required.has(key) ? "" : "?";
    const tsType = jsonSchemaToTsType(p);
    if (p.description) {
      lines.push(`  /** ${p.description} */`);
    }
    lines.push(
      `  ${/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key)}${optional}: ${tsType};`,
    );
  }

  lines.push("}");
  return lines.join("\n");
}

/** Convert a JSON Schema type to a TypeScript type string */
function jsonSchemaToTsType(schema: JsonSchema): string {
  // const literal
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }

  // enum
  if (schema.enum) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  // oneOf / anyOf → union
  if (schema.oneOf) {
    return (schema.oneOf as JsonSchema[]).map(jsonSchemaToTsType).join(" | ");
  }
  if (schema.anyOf) {
    return (schema.anyOf as JsonSchema[]).map(jsonSchemaToTsType).join(" | ");
  }

  // allOf → intersection
  if (schema.allOf) {
    return (schema.allOf as JsonSchema[]).map(jsonSchemaToTsType).join(" & ");
  }

  // not → exclude
  if (schema.not) {
    return `Exclude<unknown, ${jsonSchemaToTsType(schema.not as JsonSchema)}>`;
  }

  // $ref
  if (schema.$ref) {
    const ref = schema.$ref as string;
    // Extract name from #/$defs/Foo or #/definitions/Foo
    const match = ref.match(/\/([^/]+)$/);
    return match ? match[1] : "unknown";
  }

  switch (schema.type) {
    case "string":
      // Include format hint if present
      if (schema.format) return `string /* ${schema.format} */`;
      return "string";
    case "integer":
      return "number /* integer */";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      if (schema.items) {
        return `${jsonSchemaToTsType(schema.items as JsonSchema)}[]`;
      }
      // Tuple arrays (prefixItems)
      if (schema.prefixItems) {
        const items = (schema.prefixItems as JsonSchema[]).map(jsonSchemaToTsType);
        return `[${items.join(", ")}]`;
      }
      return "unknown[]";
    case "object":
      if (schema.properties) {
        const required = new Set((schema.required as string[]) ?? []);
        const props = Object.entries(schema.properties)
          .map(([k, v]) => {
            const opt = required.has(k) ? "" : "?";
            return `${k}${opt}: ${jsonSchemaToTsType(v as JsonSchema)}`;
          })
          .join("; ");
        // additionalProperties
        if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          const addlType = jsonSchemaToTsType(schema.additionalProperties as JsonSchema);
          return props
            ? `{ ${props}; [key: string]: ${addlType} }`
            : `Record<string, ${addlType}>`;
        }
        return `{ ${props} }`;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        return `Record<string, ${jsonSchemaToTsType(schema.additionalProperties as JsonSchema)}>`;
      }
      return "Record<string, unknown>";
    default:
      // type as array (e.g., ["string", "null"])
      if (Array.isArray(schema.type)) {
        return schema.type.map((t: string) => (t === "null" ? "null" : t === "integer" ? "number" : t)).join(" | ");
      }
      return "unknown";
  }
}

// ============================================
// File Generators
// ============================================

function generateToolFile(
  tool: McpToolDefinition,
  _sdkImport: string,
  _generateTypes: boolean,
): string {
  const schema = tool.inputSchema ?? {
    type: "object" as const,
    properties: {},
  };

  const lines: string[] = [];

  // Title
  lines.push(`# ${tool.name}`);
  lines.push("");
  if (tool.description) {
    lines.push(tool.description);
    lines.push("");
  }

  // Parameters table
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
      const req = required.has(name) ? "\u2713" : "";
      const desc = (prop.description ?? "").replace(/\|/g, "\\|");
      lines.push(`| ${name} | \`${type}\` | ${req} | ${desc} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function generateAgentConfig(
  serverInfo: McpServerInfo,
  tools: McpToolDefinition[],
  agentPath: string,
  sdkImport: string,
  visibility: string,
): string {
  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * Agent: ${agentPath}`);
  if (serverInfo.name) {
    lines.push(` * MCP Server: ${serverInfo.name} v${serverInfo.version ?? "unknown"}`);
  }
  lines.push(` *`);
  lines.push(` * Auto-generated by agents-sdk codegen.`);
  lines.push(` */`);
  lines.push("");
  lines.push(`import { defineAgent } from '${sdkImport}';`);
  lines.push("");
  lines.push(`export default defineAgent({`);
  lines.push(`  path: '${agentPath}',`);
  lines.push(`  entrypoint: './entrypoint.md',`);
  lines.push(`  visibility: '${visibility}' as const,`);
  lines.push(`});`);
  lines.push("");

  return lines.join("\n");
}

function generateEntrypoint(
  serverInfo: McpServerInfo,
  tools: McpToolDefinition[],
  agentPath: string,
): string {
  const lines: string[] = [];

  const name = serverInfo.name ?? agentPath;
  lines.push(`# ${name}`);
  lines.push("");
  if (serverInfo.version) {
    lines.push(`> MCP Server v${serverInfo.version}`);
    lines.push("");
  }
  lines.push(`You are an agent wrapping the ${name} MCP server.`);
  lines.push("");
  lines.push(`## Available Tools`);
  lines.push("");
  for (const tool of tools) {
    lines.push(`- **${tool.name}**: ${tool.description ?? "No description"}`);
  }
  lines.push("");

  return lines.join("\n");
}

function generateIndex(
  tools: McpToolDefinition[],
): string {
  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * Auto-generated index.`);
  lines.push(` */`);
  lines.push("");
  lines.push(`export { default as agent } from './agent.config.js';`);
  lines.push("");

  return lines.join("\n");
}

function generateCli(
  serverInfo: McpServerInfo,
  tools: McpToolDefinition[],
  agentPath: string,
): string {
  const name = serverInfo.name ?? agentPath;
  const lines: string[] = [];

  lines.push(`#!/usr/bin/env bun`);
  lines.push(`/**`);
  lines.push(` * CLI for ${name}`);
  lines.push(` *`);
  lines.push(` * Usage:`);
  lines.push(` *   bun cli.ts <tool_name> [json_params]`);
  lines.push(` *   bun cli.ts --list`);
  lines.push(` *`);
  lines.push(` * Auto-generated by agents-sdk codegen.`);
  lines.push(` */`);
  lines.push("");
  lines.push(`const tools = ${JSON.stringify(tools.map(t => ({ name: t.name, description: t.description ?? '' })), null, 2)};`);
  lines.push("");
  lines.push(`const args = process.argv.slice(2);`);
  lines.push("");
  lines.push(`if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {`);
  lines.push(`  console.log('${name} CLI\\n');`);
  lines.push(`  console.log('Usage: bun cli.ts <tool> [params_json]\\n');`);
  lines.push(`  console.log('Available tools:');`);
  lines.push(`  for (const t of tools) {`);
  lines.push(`    console.log(\`  \${t.name.padEnd(30)} \${t.description}\`);`);
  lines.push(`  }`);
  lines.push(`  process.exit(0);`);
  lines.push(`}`);
  lines.push("");
  lines.push(`if (args[0] === '--list') {`);
  lines.push(`  for (const t of tools) {`);
  lines.push(`    console.log(\`\${t.name}\\t\${t.description}\`);`);
  lines.push(`  }`);
  lines.push(`  process.exit(0);`);
  lines.push(`}`);
  lines.push("");
  lines.push(`const toolName = args[0];`);
  lines.push(`const params = args[1] ? JSON.parse(args[1]) : {};`);
  lines.push("");
  lines.push(`if (!tools.find(t => t.name === toolName)) {`);
  lines.push(`  console.error(\`Unknown tool: \${toolName}\`);`);
  lines.push(`  console.error(\`Available: \${tools.map(t => t.name).join(', ')}\`);`);
  lines.push(`  process.exit(1);`);
  lines.push(`}`);
  lines.push("");
  lines.push(`// TODO: Connect to MCP server and execute the tool`);
  lines.push(`console.log(JSON.stringify({ tool: toolName, params, status: 'not_connected' }, null, 2));`);
  lines.push("");

  return lines.join("\n");
}

// ============================================
// Manifest
// ============================================

/** Manifest stored in outDir for `agents-sdk use` */
export interface CodegenManifest {
  agentPath: string;
  serverSource: ServerSource;
  serverInfo: McpServerInfo;
  tools: { name: string; description?: string }[];
  generatedAt: string;
}

function generateManifest(
  serverSource: ServerSource,
  serverInfo: McpServerInfo,
  tools: McpToolDefinition[],
  agentPath: string,
): string {
  const manifest: CodegenManifest = {
    agentPath,
    serverSource,
    serverInfo,
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    generatedAt: new Date().toISOString(),
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

// ============================================
// Main: codegen()
// ============================================

/**
 * Connect to an MCP server, introspect its tools, and generate
 * agent-definition source files.
 */
export async function codegen(options: CodegenOptions): Promise<CodegenResult> {
  const sdkImport = options.sdkImport ?? "@slashfi/agents-sdk";
  const generateTypes = options.types !== false;
  const generateCliFile = options.cli !== false;
  const visibility = options.visibility ?? "public";
  const outDir = resolve(options.outDir);

  // 1. Connect to MCP server
  const transport = parseServerSource(options.server);

  let serverInfo: McpServerInfo = {};
  let tools: McpToolDefinition[] = [];

  try {
    // 2. Initialize handshake
    const initResult = (await transport.send("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agents-sdk-codegen", version: "1.0.0" },
    })) as {
      serverInfo?: McpServerInfo;
      protocolVersion?: string;
      capabilities?: { tools?: unknown };
    };

    // Validate protocol version
    if (
      initResult?.protocolVersion &&
      !SUPPORTED_PROTOCOL_VERSIONS.includes(initResult.protocolVersion)
    ) {
      throw new Error(
        `Server protocol version ${initResult.protocolVersion} is not supported. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
      );
    }

    serverInfo = initResult?.serverInfo ?? {};

    // Send initialized notification (no id — this is a notification, not a request)
    await transport.notify("notifications/initialized");

    // 3. List tools (with pagination)
    const allTools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const toolsResult = (await transport.send("tools/list", {
        ...(cursor ? { cursor } : {}),
      })) as {
        tools?: McpToolDefinition[];
        nextCursor?: string;
      };
      allTools.push(...(toolsResult?.tools ?? []));
      cursor = toolsResult?.nextCursor;
    } while (cursor);
    tools = allTools;
  } finally {
    await transport.close();
  }

  if (tools.length === 0) {
    throw new Error(
      "MCP server returned no tools. Is the server running and configured correctly?",
    );
  }

  // 4. Derive agent path
  const agentPath =
    options.agentPath ??
    `@${(options.name ?? serverInfo.name ?? "mcp-agent").toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

  // 5. Create output directory
  mkdirSync(outDir, { recursive: true });

  const files: string[] = [];

  // 6. Generate tool files
  const toolFiles: string[] = [];
  for (const tool of tools) {
    const fileName = `${toKebabCase(tool.name)}.tool.md`;
    const content = generateToolFile(tool, sdkImport, generateTypes);
    writeFileSync(join(outDir, fileName), content);
    toolFiles.push(fileName);
    files.push(fileName);
  }

  // 7. Generate entrypoint.md
  const entrypoint = generateEntrypoint(serverInfo, tools, agentPath);
  writeFileSync(join(outDir, "entrypoint.md"), entrypoint);
  files.push("entrypoint.md");

  // 8. Generate agent.config.ts
  const agentConfig = generateAgentConfig(
    serverInfo,
    tools,
    agentPath,
    sdkImport,
    visibility,
  );
  writeFileSync(join(outDir, "agent.config.ts"), agentConfig);
  files.push("agent.config.ts");

  // 9. Generate index.ts
  const index = generateIndex(tools);
  writeFileSync(join(outDir, "index.ts"), index);
  files.push("index.ts");

  // 10. Generate CLI
  if (generateCliFile) {
    const cli = generateCli(serverInfo, tools, agentPath);
    writeFileSync(join(outDir, "cli.ts"), cli);
    files.push("cli.ts");
  }

  // 11. Generate manifest (for `agents-sdk use`)
  const manifest = generateManifest(options.server, serverInfo, tools, agentPath);
  writeFileSync(join(outDir, ".codegen-manifest.json"), manifest);
  files.push(".codegen-manifest.json");

  return {
    outDir,
    serverInfo,
    toolCount: tools.length,
    toolFiles,
    files,
  };
}

// ============================================
// Use: execute a tool on a codegenned agent
// ============================================

/**
 * Execute a tool on a previously codegenned agent by reconnecting
 * to the MCP server and calling the tool.
 */
export async function useAgent(options: {
  /** Path to the generated agent directory (contains .codegen-manifest.json) */
  agentDir: string;
  /** Tool name to execute */
  tool: string;
  /** Tool parameters */
  params?: Record<string, unknown>;
}): Promise<unknown> {
  const manifestPath = join(
    resolve(options.agentDir),
    ".codegen-manifest.json",
  );

  if (!existsSync(manifestPath)) {
    throw new Error(
      `No codegen manifest found at ${manifestPath}. Run codegen first.`,
    );
  }

  const manifest: CodegenManifest = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  );

  // Verify tool exists
  const toolDef = manifest.tools.find((t) => t.name === options.tool);
  if (!toolDef) {
    const available = manifest.tools.map((t) => t.name).join(", ");
    throw new Error(
      `Unknown tool '${options.tool}'. Available: ${available}`,
    );
  }

  // Connect to server and call tool
  const transport = parseServerSource(manifest.serverSource);

  try {
    await transport.send("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agents-sdk-use", version: "1.0.0" },
    });

    await transport.notify("notifications/initialized");

    const result = await transport.send("tools/call", {
      name: options.tool,
      arguments: options.params ?? {},
    });

    return result;
  } finally {
    await transport.close();
  }
}

/**
 * List tools available on a codegenned agent.
 */
export function listAgentTools(agentDir: string): CodegenManifest["tools"] {
  const manifestPath = join(resolve(agentDir), ".codegen-manifest.json");

  if (!existsSync(manifestPath)) {
    throw new Error(
      `No codegen manifest found at ${manifestPath}. Run codegen first.`,
    );
  }

  const manifest: CodegenManifest = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  );
  return manifest.tools;
}
