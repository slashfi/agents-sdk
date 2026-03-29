/**
 * MCP Client — Talks to agent registries via their MCP meta-tools.
 *
 * The registry exposes two MCP tools:
 *   - list_agents  — discover all agents + their tools
 *   - call_agent   — execute a tool on a specific agent
 *
 * This is the right architecture: the registry is an MCP server
 * with meta-tools for agent management, not a flat namespace.
 */

// ============================================
// Types
// ============================================

/** An agent as returned by the registry's list_agents */
export interface RegistryAgent {
  path: string;
  name: string;
  description?: string;
  integration?: unknown;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
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
  private agentsCache: Map<string, RegistryAgent[]> = new Map();

  constructor(private registryUrls: string[]) {}

  /**
   * Call an MCP tool on the registry via JSON-RPC.
   */
  private async callRegistryTool(
    registryUrl: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const request = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
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

    // MCP tools/call returns { content: [{ type: "text", text: "..." }] }
    const result = response.result as any;
    if (result?.content?.[0]?.text) {
      return JSON.parse(result.content[0].text);
    }
    return result;
  }

  /**
   * List all agents from a registry via the list_agents tool.
   */
  async listAgents(registryUrl: string): Promise<RegistryAgent[]> {
    const cached = this.agentsCache.get(registryUrl);
    if (cached) return cached;

    const result = (await this.callRegistryTool(registryUrl, "list_agents")) as any;
    const agents: RegistryAgent[] = result?.agents ?? [];
    this.agentsCache.set(registryUrl, agents);
    return agents;
  }

  /**
   * Search/discover agents across all registries.
   */
  async search(query?: string): Promise<Array<{ agents: RegistryAgent[]; registry: string }>> {
    const results: Array<{ agents: RegistryAgent[]; registry: string }> = [];

    for (const registryUrl of this.registryUrls) {
      try {
        let agents = await this.listAgents(registryUrl);

        // Filter by query if provided
        if (query) {
          const q = query.toLowerCase();
          agents = agents.filter(
            (a) =>
              a.name.toLowerCase().includes(q) ||
              a.path.toLowerCase().includes(q) ||
              (a.description?.toLowerCase().includes(q) ?? false) ||
              a.tools.some(
                (t) =>
                  t.name.toLowerCase().includes(q) ||
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
   * Get info about a specific agent.
   */
  async getAgent(name: string): Promise<{ agent: RegistryAgent; registry: string } | null> {
    const cleanName = name.replace(/^@/, "");

    for (const registryUrl of this.registryUrls) {
      try {
        const agents = await this.listAgents(registryUrl);
        const agent = agents.find(
          (a) => a.path === cleanName || a.name.toLowerCase() === cleanName.toLowerCase(),
        );
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
   * Call a tool on an agent via the call_agent meta-tool.
   */
  async callTool(
    agentName: string,
    toolName: string,
    params: Record<string, unknown>,
    credentials?: Record<string, string>,
  ): Promise<unknown> {
    const cleanAgent = agentName.replace(/^@/, "");

    for (const registryUrl of this.registryUrls) {
      try {
        // Verify agent exists
        const agents = await this.listAgents(registryUrl);
        const agent = agents.find(
          (a) => a.path === cleanAgent || a.name.toLowerCase() === cleanAgent.toLowerCase(),
        );
        if (!agent) continue;

        const request: Record<string, unknown> = {
          action: "execute_tool",
          path: agent.path,
          tool: toolName,
          params,
        };

        // Pass credentials if available
        if (credentials && Object.keys(credentials).length > 0) {
          request._credentials = credentials;
        }

        return await this.callRegistryTool(registryUrl, "call_agent", { request });
      } catch (err) {
        // If agent was found but call failed, propagate
        if (err instanceof Error && !err.message.includes("fetch failed")) {
          throw err;
        }
        continue;
      }
    }

    throw new Error(
      `Agent '${agentName}' not found on any configured registry`,
    );
  }

  /**
   * Clear the agents cache.
   */
  clearCache(): void {
    this.agentsCache.clear();
  }
}
