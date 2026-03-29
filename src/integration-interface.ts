/**
 * Integration interface — standard tools that integration agents implement.
 *
 * Any agent that acts as an integration source should implement these tools.
 * They are all internal visibility and only callable by @integrations.
 */

import { defineTool } from "./define.js";
import type { IntegrationsStore } from "./integrations-store.js";
import type { ToolContext, ToolDefinition } from "./types.js";

export interface IntegrationDefinition {
  id: string;
  agentPath: string;
  name: string;
  description: string;
  type: "oauth" | "credentials" | "config";
  configSchema?: Record<string, unknown>;
}

export interface IntegrationInterfaceConfig {
  agentPath: string;
  store: IntegrationsStore;
  discover: () => Promise<IntegrationDefinition[]>;
  setup: (
    config: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<{
    success: boolean;
    integrationId?: string;
    oauthUrl?: string;
    error?: string;
  }>;
  connect?: (
    integrationId: string,
    ctx: ToolContext,
  ) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Create the standard _integration tools for an agent.
 * Returns an array of ToolDefinitions to include in the agent's tools.
 */
export function createIntegrationTools(
  config: IntegrationInterfaceConfig,
): ToolDefinition<ToolContext>[] {
  const { agentPath, store, discover, setup, connect } = config;

  const discoverTool = defineTool({
    name: "discover_integrations",
    description: `Discover available integrations for ${agentPath}.`,
    visibility: "internal" as const,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    execute: async () => {
      const available = await discover();
      return available;
    },
  });

  const setupTool = defineTool({
    name: "setup_integration",
    description: `Set up a new integration for ${agentPath}.`,
    visibility: "internal" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        config: { type: "object", description: "Integration configuration" },
      },
      required: ["config"],
    },
    execute: async (
      input: { config: Record<string, unknown> },
      ctx: ToolContext,
    ) => {
      const result = await setup(input.config, ctx);
      if (result.success && !result.oauthUrl) {
        // Direct setup (no OAuth needed) — create integration row
        const integration = await store.create({
          agentPath,
          config: input.config,
          installedBy: ctx.callerId,
        });
        return { success: true, integrationId: integration.id };
      }
      return result;
    },
  });

  const connectTool = defineTool({
    name: "connect_integration",
    description: `Test or authorize a ${agentPath} integration connection.`,
    visibility: "internal" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        integration_id: {
          type: "string",
          description: "Integration ID to connect",
        },
      },
      required: ["integration_id"],
    },
    execute: async (input: { integration_id: string }, ctx: ToolContext) => {
      if (connect) {
        const result = await connect(input.integration_id, ctx);
        if (result.success) {
          await store.update(input.integration_id, { status: "active" });
        } else {
          await store.update(input.integration_id, { status: "error" });
        }
        return result;
      }
      return { success: true };
    },
  });

  const listTool = defineTool({
    name: "list_integrations",
    description: `List installed integrations for ${agentPath}.`,
    visibility: "internal" as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        tenant_id: { type: "string", description: "Filter by tenant" },
      },
    },
    execute: async (input: { tenant_id?: string }) => {
      const integrations = await store.listByAgent(agentPath, input.tenant_id);
      return integrations;
    },
  });

  return [
    discoverTool,
    setupTool,
    connectTool,
    listTool,
  ] as ToolDefinition<ToolContext>[];
}
