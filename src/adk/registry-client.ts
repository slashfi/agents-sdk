/**
 * Registry Client — HTTP client for talking to agent registries.
 *
 * Handles:
 *   - Discovery via /.well-known/configuration
 *   - GET /agents — list/search agents
 *   - GET /agents/:name — agent detail + tools
 *   - POST /agents/:name — MCP tool call
 */

import type { RegistryConfiguration, AgentListing } from "../registry-consumer.js";

// ============================================
// Types
// ============================================

export interface AgentDetail {
  path: string;
  name: string;
  description?: string;
  publisher: string;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  securityScheme?: {
    type: "apiKey" | "oauth2" | "none";
    displayName?: string;
    /** For apiKey: which fields to collect */
    fields?: Array<{
      name: string;
      description?: string;
      required?: boolean;
    }>;
    /** For oauth2 */
    authorizationUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
    clientId?: string;
  };
}

export interface SearchResult {
  agents: AgentListing[];
  registry: string;
}

// ============================================
// Client
// ============================================

export class RegistryClient {
  private configCache: Map<string, RegistryConfiguration> = new Map();

  constructor(private registryUrls: string[]) {}

  /**
   * Discover registry configuration.
   */
  async discover(registryUrl: string): Promise<RegistryConfiguration> {
    const cached = this.configCache.get(registryUrl);
    if (cached) return cached;

    const url = new URL("/.well-known/configuration", registryUrl);
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(
        `Failed to discover registry at ${registryUrl}: ${res.status} ${res.statusText}`,
      );
    }
    const config = (await res.json()) as RegistryConfiguration;
    this.configCache.set(registryUrl, config);
    return config;
  }

  /**
   * Search/list agents across all configured registries.
   */
  async search(query?: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const registryUrl of this.registryUrls) {
      try {
        const config = await this.discover(registryUrl);
        const agentsEndpoint = config.agents_endpoint ?? `${registryUrl}/agents`;

        const url = new URL(agentsEndpoint);
        if (query) url.searchParams.set("q", query);

        const res = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
        });

        if (!res.ok) continue;

        const data = await res.json() as any;
        const agents = Array.isArray(data) ? data : (data.agents ?? []);
        results.push({ agents, registry: registryUrl });
      } catch (err) {
        // Skip unreachable registries
        console.error(`Warning: could not reach ${registryUrl}: ${err instanceof Error ? err.message : err}`);
      }
    }

    return results;
  }

  /**
   * Get detailed info about a specific agent.
   */
  async getAgent(name: string): Promise<{ agent: AgentDetail; registry: string } | null> {
    for (const registryUrl of this.registryUrls) {
      try {
        const cleanName = name.replace(/^@/, "");
        const url = `${registryUrl}/agents/${cleanName}`;
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
        });

        if (!res.ok) continue;

        const agent = (await res.json()) as AgentDetail;
        return { agent, registry: registryUrl };
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Call a tool on an agent via MCP protocol.
   */
  async callTool(
    agentName: string,
    toolName: string,
    params: Record<string, unknown>,
    credentials?: Record<string, string>,
  ): Promise<unknown> {
    for (const registryUrl of this.registryUrls) {
      try {
        const cleanName = agentName.replace(/^@/, "");
        const url = `${registryUrl}/agents/${cleanName}`;

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        // Pass credentials as X-Agent-Credentials header
        if (credentials && Object.keys(credentials).length > 0) {
          headers["X-Agent-Credentials"] = Buffer.from(
            JSON.stringify(credentials),
          ).toString("base64");
        }

        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: toolName,
              arguments: params,
            },
          }),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`${res.status}: ${text}`);
        }

        const rpcResponse = await res.json() as any;
        if (rpcResponse.error) {
          throw new Error(
            `RPC error: ${rpcResponse.error.message ?? JSON.stringify(rpcResponse.error)}`,
          );
        }

        return rpcResponse.result;
      } catch (err) {
        // If it's an actual error response, throw it
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
}
