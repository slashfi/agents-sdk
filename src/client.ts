/**
 * Agent Client
 *
 * Creates a typed client from a SerializedAgentDefinition.
 * The client spawns (or connects to) the MCP server and proxies
 * tool calls via JSON-RPC.
 *
 * @example
 * ```typescript
 * import { createClient } from '@slashfi/agents-sdk';
 * import definition from './agents/notion/definition.json';
 *
 * const client = createClient(definition, {
 *   env: { NOTION_TOKEN: process.env.NOTION_TOKEN },
 * });
 *
 * const result = await client.call('API-post-search', { query: 'meeting notes' });
 * await client.close();
 * ```
 */

import { type ChildProcess, spawn } from "node:child_process";
import type {
  SerializedAgentDefinition,
  SerializedTool,
} from "./serialized.js";

// ============================================
// Client Options
// ============================================

export interface CreateClientOptions {
  /** Extra environment variables for the MCP server process */
  env?: Record<string, string | undefined>;
  /** Override the server command (defaults to definition.serverSource) */
  serverCommand?: string;
  /** Timeout for tool calls in ms (default: 30000) */
  timeout?: number;
}

// ============================================
// Agent Client
// ============================================

export interface AgentClient {
  /** The definition this client was created from */
  readonly definition: SerializedAgentDefinition;

  /** List available tools */
  tools(): SerializedTool[];

  /** Call a tool by name */
  call(toolName: string, input?: Record<string, unknown>): Promise<unknown>;

  /** Check if connected */
  isConnected(): boolean;

  /** Close the MCP server connection */
  close(): void;
}

// ============================================
// MCP Stdio Transport
// ============================================

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class McpStdioClient implements AgentClient {
  readonly definition: SerializedAgentDefinition;
  private proc: ChildProcess | null = null;
  private messageId = 0;
  private buffer = "";
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private serverCommand: string;
  private env: Record<string, string | undefined>;
  private timeout: number;

  constructor(
    definition: SerializedAgentDefinition,
    options: CreateClientOptions = {},
  ) {
    this.definition = definition;
    this.serverCommand = options.serverCommand ?? definition.serverSource ?? "";
    this.env = options.env ?? {};
    this.timeout = options.timeout ?? 30000;

    if (!this.serverCommand) {
      throw new Error(
        `No server command for agent "${definition.path}". Set serverSource in the definition or pass serverCommand in options.`,
      );
    }
  }

  tools(): SerializedTool[] {
    return this.definition.tools;
  }

  isConnected(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  async call(
    toolName: string,
    input: Record<string, unknown> = {},
  ): Promise<unknown> {
    // Validate tool exists
    const tool = this.definition.tools.find((t) => t.name === toolName);
    if (!tool) {
      const available = this.definition.tools.map((t) => t.name).join(", ");
      throw new Error(`Tool "${toolName}" not found. Available: ${available}`);
    }

    // Ensure connected + initialized
    await this.ensureInitialized();

    // Send tools/call
    const result = await this.sendRequest("tools/call", {
      name: toolName,
      arguments: input,
    });

    // MCP tools/call returns { content: [{ type, text }] }
    const resultObj = result as Record<string, unknown> | null;
    if (resultObj && typeof resultObj === "object" && "content" in resultObj) {
      const content = resultObj.content;
      if (Array.isArray(content) && content.length > 0) {
        const first = content[0];
        if (first.type === "text") {
          try {
            return JSON.parse(first.text);
          } catch {
            return first.text;
          }
        }
        return first;
      }
    }
    return result;
  }

  close(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.initialized = false;
    this.initPromise = null;
    // Reject all pending
    for (const req of Array.from(this.pending.values())) {
      clearTimeout(req.timer);
      req.reject(new Error("Client closed"));
    }
    this.pending.clear();
  }

  // ── Private ──

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.connect();
    await this.initPromise;
    this.initialized = true;
  }

  private async connect(): Promise<void> {
    const parts = this.serverCommand.split(/\s+/);
    this.proc = spawn(parts[0], parts.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.on("error", (err) => {
      for (const req of Array.from(this.pending.values())) {
        clearTimeout(req.timer);
        req.reject(err);
      }
      this.pending.clear();
    });

    // Initialize handshake
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agents-sdk-client", version: "1.0.0" },
    });

    // Send initialized notification
    this.sendNotification("notifications/initialized");
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout after ${this.timeout}ms calling ${method}`));
      }, this.timeout);

      this.pending.set(id, { resolve, reject, timer });

      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.proc?.stdin?.write(`${msg}\n`);
    });
  }

  private sendNotification(
    method: string,
    params?: Record<string, unknown>,
  ): void {
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    });
    this.proc?.stdin?.write(`${msg}\n`);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.id != null && this.pending.has(parsed.id)) {
          const req = this.pending.get(parsed.id);
          if (!req) continue;
          this.pending.delete(parsed.id);
          clearTimeout(req.timer);
          if (parsed.error) {
            req.reject(new Error(JSON.stringify(parsed.error)));
          } else {
            req.resolve(parsed.result);
          }
        }
      } catch {
        // ignore non-JSON lines (stderr leakage, etc.)
      }
    }
  }
}

// ============================================
// Factory
// ============================================

/**
 * Create an agent client from a serialized definition.
 *
 * The client lazily spawns the MCP server on first call and
 * proxies tool invocations via JSON-RPC over stdio.
 */
export function createClient(
  definition: SerializedAgentDefinition,
  options?: CreateClientOptions,
): AgentClient {
  return new McpStdioClient(definition, options);
}
