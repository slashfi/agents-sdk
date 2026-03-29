/**
 * MCP Client — Pure MCP transport for talking to agent registries.
 *
 * Everything goes through JSON-RPC over HTTP:
 *   - tools/list  — discover all agents + tools
 *   - tools/call  — execute a tool on an agent
 *
 * Tool names are namespaced as `agent__tool` (e.g. `notion__search`).
 * The registry is an MCP server; `adk` is an MCP client.
 */

// ============================================
// Types
// ============================================

/** A tool as returned by the registry's tools/list */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Parsed tool with agent namespace separated */
export interface ParsedTool {
  agent: string;
  tool: string;
  fullName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Grouped by agent for display */
export interface AgentInfo {
  name: string;
  tools: ParsedTool[];
  description?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ============================================
// Client
// ============================================

export class McpRegistryClient {
  private nextId = 1;
  private toolsCache: Map<string, McpTool[]> = new Map();

  constructor(private registryUrls: string[]) {}

  /**
   * Send a JSON-RPC request to a registry.
   */
  private async rpc(
    registryUrl: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      ...(params ? { params } : {}),
    };

    const res = await fetch(registryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Registry ${registryUrl} returned ${res.status}: ${text}`);
    }

    const response = (await res.json()) as JsonRpcResponse;
    if (response.error) {
      throw new Error(
        `RPC error: ${response.error.message}${response.error.data ? ` (${JSON.stringify(response.error.data)})` : ""}`,
      );
    }

    return response.result;
  }

  /**
   * List all tools from a registry via tools/list.
   */
  async listTools(registryUrl: string): Promise<McpTool[]> {
    const cached = this.toolsCache.get(registryUrl);
    if (cached) return cached;

    const result = (await this.rpc(registryUrl, "tools/list")) as any;
    const tools: McpTool[] = result?.tools ?? [];
    this.toolsCache.set(registryUrl, tools);
    return tools;
  }

  /**
   * Parse a namespaced tool name (agent__tool) into parts.
   */
  static parseTool(mcpTool: McpTool): ParsedTool {
    const sep = mcpTool.name.indexOf("__");
    if (sep === -1) {
      return {
        agent: "_unknown",
        tool: mcpTool.name,
        fullName: mcpTool.name,
        description: mcpTool.description,
        inputSchema: mcpTool.inputSchema,
      };
    }
    return {
      agent: mcpTool.name.substring(0, sep),
      tool: mcpTool.name.substring(sep + 2),
      fullName: mcpTool.name,
      description: mcpTool.description,
      inputSchema: mcpTool.inputSchema,
    };
  }

  /**
   * Group tools by agent.
   */
  static groupByAgent(tools: McpTool[]): AgentInfo[] {
    const agents = new Map<string, ParsedTool[]>();

    for (const t of tools) {
      const parsed = McpRegistryClient.parseTool(t);
      if (!agents.has(parsed.agent)) {
        agents.set(parsed.agent, []);
      }
      agents.get(parsed.agent)!.push(parsed);
    }

    return Array.from(agents.entries()).map(([name, tools]) => ({
      name,
      tools,
      // Use the first tool's description prefix if available
      description: undefined,
    }));
  }

  /**
   * Search/discover agents across all registries.
   * Returns agents grouped by name with their tools.
   */
  async search(query?: string): Promise<Array<{ agents: AgentInfo[]; registry: string }>> {
    const results: Array<{ agents: AgentInfo[]; registry: string }> = [];

    for (const registryUrl of this.registryUrls) {
      try {
        const tools = await this.listTools(registryUrl);
        let agents = McpRegistryClient.groupByAgent(tools);

        // Filter by query if provided
        if (query) {
          const q = query.toLowerCase();
          agents = agents.filter(
            (a) =>
              a.name.toLowerCase().includes(q) ||
              a.tools.some(
                (t) =>
                  t.tool.toLowerCase().includes(q) ||
                  (t.description?.toLowerCase().includes(q) ?? false),
              ),
          );
        }

        results.push({ agents, registry: registryUrl });
      } catch (err) {
        console.error(
          `Warning: could not reach ${registryUrl}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return results;
  }

  /**
   * Get info about a specific agent (its tools).
   */
  async getAgent(name: string): Promise<{ agent: AgentInfo; registry: string } | null> {
    const cleanName = name.replace(/^@/, "");

    for (const registryUrl of this.registryUrls) {
      try {
        const tools = await this.listTools(registryUrl);
        const agents = McpRegistryClient.groupByAgent(tools);
        const agent = agents.find((a) => a.name === cleanName);
        if (agent) {
          return { agent, registry: registryUrl };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Call a tool on an agent via tools/call.
   */
  async callTool(
    agentName: string,
    toolName: string,
    params: Record<string, unknown>,
    credentials?: Record<string, string>,
  ): Promise<unknown> {
    const cleanAgent = agentName.replace(/^@/, "");
    const fullName = `${cleanAgent}__${toolName}`;

    for (const registryUrl of this.registryUrls) {
      try {
        // Verify tool exists
        const tools = await this.listTools(registryUrl);
        const tool = tools.find((t) => t.name === fullName);
        if (!tool) continue;

        const callParams: Record<string, unknown> = {
          name: fullName,
          arguments: params,
        };

        // Pass credentials in the call params
        if (credentials && Object.keys(credentials).length > 0) {
          callParams._credentials = credentials;
        }

        return await this.rpc(registryUrl, "tools/call", callParams);
      } catch (err) {
        // If tool was found but call failed, propagate the error
        if (err instanceof Error && !err.message.includes("fetch failed")) {
          throw err;
        }
        continue;
      }
    }

    throw new Error(
      `Tool '${toolName}' on agent '${agentName}' not found on any configured registry`,
    );
  }

  /**
   * Clear the tools cache (e.g. after adding/removing agents).
   */
  clearCache(): void {
    this.toolsCache.clear();
  }
}
