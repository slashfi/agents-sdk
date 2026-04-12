/**
 * Config Agent (@config)
 *
 * Built-in agent for managing consumer configuration — refs and registries.
 * Replaces @integrations and the LLM-facing parts of @auth.
 *
 * Provides:
 * - add_ref / remove_ref / list_refs for managing agent refs
 * - add_registry for registering new registries
 * - FsStore interface for pluggable filesystem storage (VCS-backed or local)
 *
 * @example
 * ```typescript
 * import { createAgentRegistry, createConfigAgent } from '@slashfi/agents-sdk';
 *
 * const registry = createAgentRegistry();
 * registry.register(createConfigAgent({
 *   store: myFsStore,
 * }));
 * ```
 */

import type { ConsumerConfig, RefEntry, RegistryAuth } from "../define-config.js";
import { normalizeRef } from "../define-config.js";
import { defineAgent, defineTool } from "../define.js";
import type { AgentDefinition, ToolContext, ToolDefinition } from "../types.js";

// ============================================
// FsStore Interface
// ============================================

/**
 * Filesystem store for reading/writing consumer configs.
 * The storage engine (VCS, local fs, etc.) is abstracted away.
 */
export interface FsStore {
  /** Read a file as UTF-8 string. Returns null if not found. */
  readFile(path: string): Promise<string | null>;
  /** Write a file with UTF-8 content. Creates parent dirs if needed. */
  writeFile(path: string, content: string): Promise<void>;
}

// ============================================
// Config Persistence
// ============================================

const CONFIG_PATH = "consumer-config.json";

async function readConfig(store: FsStore): Promise<ConsumerConfig> {
  const content = await store.readFile(CONFIG_PATH);
  if (!content) return {};
  try {
    return JSON.parse(content) as ConsumerConfig;
  } catch {
    return {};
  }
}

async function writeConfig(
  store: FsStore,
  config: ConsumerConfig,
): Promise<void> {
  await store.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ============================================
// Config Agent Options
// ============================================

export interface ConfigAgentOptions {
  /** Filesystem store for persisting consumer config */
  store: FsStore;

  /**
   * Resolve the FsStore for a specific user.
   * When provided, refs are stored per-user.
   * The callerId from ToolContext is passed.
   */
  resolveUserStore?: (callerId: string) => FsStore;
}

// ============================================
// Create Config Agent
// ============================================

export function createConfigAgent(
  options: ConfigAgentOptions,
): AgentDefinition {
  const { store, resolveUserStore } = options;

  function getStore(ctx: ToolContext): FsStore {
    if (resolveUserStore && ctx.callerId) {
      return resolveUserStore(ctx.callerId);
    }
    return store;
  }

  // ---- add_ref ----
  const addRefTool = defineTool({
    name: "add_ref",
    description:
      "Add or update an agent ref in the consumer config. " +
      "The ref is persisted to the config store.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ref: {
          type: "string",
          description: 'Agent ref name (e.g. "notion", "linear")',
        },
        as: {
          type: "string",
          description: "Local alias (for multi-instance refs)",
        },
        url: {
          type: "string",
          description: "Direct URL to the agent",
        },
        config: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Per-instance config (secret URIs or literal values)",
        },
        registry: {
          type: "string",
          description:
            'Registry to resolve from (e.g. "public", "mcp", "https")',
        },
      },
      required: ["ref"],
    },
    execute: async (
      input: {
        ref: string;
        as?: string;
        url?: string;
        config?: Record<string, string>;
        registry?: string;
      },
      ctx: ToolContext,
    ) => {
      const fs = getStore(ctx);
      const currentConfig = await readConfig(fs);

      const entry: RefEntry = {
        ref: input.ref,
        ...(input.as && { as: input.as }),
        ...(input.url && { url: input.url }),
        ...(input.config && { config: input.config }),
        ...(input.registry && { registry: input.registry }),
      };

      // Upsert: find existing ref by name/alias, replace or append
      const name = input.as ?? input.ref;
      const refs = currentConfig.refs ?? [];
      const existingIdx = refs.findIndex((r) => {
        const normalized = normalizeRef(r);
        return normalized.name === name;
      });

      if (existingIdx >= 0) {
        refs[existingIdx] = entry;
      } else {
        refs.push(entry);
      }

      currentConfig.refs = refs;
      await writeConfig(fs, currentConfig);

      return {
        added: true,
        ref: input.ref,
        name,
      };
    },
  });

  // ---- remove_ref ----
  const removeRefTool = defineTool({
    name: "remove_ref",
    description: "Remove an agent ref from the consumer config by name or alias.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Ref name or alias to remove",
        },
      },
      required: ["name"],
    },
    execute: async (
      input: { name: string },
      ctx: ToolContext,
    ) => {
      const fs = getStore(ctx);
      const currentConfig = await readConfig(fs);
      const refs = currentConfig.refs ?? [];

      const before = refs.length;
      currentConfig.refs = refs.filter((r) => {
        const normalized = normalizeRef(r);
        return normalized.name !== input.name;
      });

      if (currentConfig.refs.length === before) {
        return { removed: false, error: `Ref "${input.name}" not found` };
      }

      await writeConfig(fs, currentConfig);
      return { removed: true, name: input.name };
    },
  });

  // ---- list_refs ----
  const listRefsTool = defineTool({
    name: "list_refs",
    description:
      "List all agent refs in the consumer config. " +
      "Returns normalized refs with their names and config.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    execute: async (_input: unknown, ctx: ToolContext) => {
      const fs = getStore(ctx);
      const currentConfig = await readConfig(fs);
      const refs = (currentConfig.refs ?? []).map(normalizeRef);
      return { refs };
    },
  });

  // ---- add_registry ----
  const addRegistryTool = defineTool({
    name: "add_registry",
    description:
      "Add or update a registry in the consumer config. " +
      "Registries are where refs resolve from.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: 'Human-readable name (e.g. "public", "internal")',
        },
        url: {
          type: "string",
          description: "Registry URL",
        },
        auth: {
          type: "object",
          description: "Auth config for the registry",
          properties: {
            type: {
              type: "string",
              enum: ["none", "bearer", "api-key", "jwt"],
            },
          },
        },
      },
      required: ["url"],
    },
    execute: async (
      input: {
        name?: string;
        url: string;
        auth?: { type: string; [key: string]: unknown };
      },
      ctx: ToolContext,
    ) => {
      const fs = getStore(ctx);
      const currentConfig = await readConfig(fs);

      const registries = currentConfig.registries ?? [];
      const entry = {
        url: input.url,
        ...(input.name && { name: input.name }),
        ...(input.auth && { auth: input.auth as RegistryAuth }),
      };

      // Upsert by URL
      const existingIdx = registries.findIndex((r) => {
        const url = typeof r === "string" ? r : r.url;
        return url === input.url;
      });

      if (existingIdx >= 0) {
        registries[existingIdx] = entry;
      } else {
        registries.push(entry);
      }

      currentConfig.registries = registries;
      await writeConfig(fs, currentConfig);

      return {
        added: true,
        url: input.url,
        name: input.name ?? new URL(input.url).hostname,
      };
    },
  });

  // ---- Define the agent ----
  return defineAgent({
    path: "@config",
    entrypoint:
      "Consumer config management. Use add_ref/remove_ref/list_refs to manage agent refs, " +
      "and add_registry to configure registries.",
    config: {
      name: "Config",
      description:
        "Manage consumer config — add/remove/list agent refs and registries. " +
        "Replaces @integrations for connecting to third-party services.",
    },
    tools: [addRefTool, removeRefTool, listRefsTool, addRegistryTool] as ToolDefinition<ToolContext>[],
  });
}
