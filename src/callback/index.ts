/**
 * Agent Callback — Deferred call_agent execution with triggers.
 *
 * An agent_callback is a call_agent command with an optional trigger.
 * When the trigger fires (e.g., user submits a form), template references
 * like {{trigger.variable_name}} are resolved with the trigger's values
 * and the call_agent command is executed.
 *
 * This module provides the unopinionated contract:
 * - Trigger schema (extensible discriminated union)
 * - Template resolution
 * - Store interface
 * - Validation utilities
 *
 * No platform-specific code (no Slack, no CockroachDB, no Atlas).
 */

// ---------------------------------------------------------------------------
// Trigger Schema
// ---------------------------------------------------------------------------

/**
 * Base trigger type. Implementations extend this with specific trigger sources
 * (e.g., slack_block_kit, webhook, timer).
 *
 * The `type` field discriminates between trigger sources.
 * Additional fields are trigger-specific.
 */
export interface AgentCallbackTrigger {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Callback Status
// ---------------------------------------------------------------------------

export type AgentCallbackStatus =
  | 'pending'
  | 'completed'
  | 'expired'
  | 'cancelled';

// ---------------------------------------------------------------------------
// Callback Entry
// ---------------------------------------------------------------------------

/**
 * A stored agent_callback — a call_agent command waiting for its trigger to fire.
 */
export interface AgentCallbackEntry {
  id: string;
  status: AgentCallbackStatus;
  /** The call_agent command (includes trigger). Params may contain {{trigger.x}} templates. */
  callback: Record<string, unknown>;
  /** Key-value attributes for this callback (e.g., creator info, trigger metadata). */
  attributes: Record<string, string>;
  createdAt: Date;
  completedAt?: Date;
}

// ---------------------------------------------------------------------------
// Create Options
// ---------------------------------------------------------------------------

export interface CreateAgentCallbackOptions {
  /** The call_agent command (includes trigger). May contain {{trigger.x}} template references in params. */
  callback: Record<string, unknown>;
  /** Initial attributes to set on creation. */
  attributes?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Resolve Options
// ---------------------------------------------------------------------------

export interface ResolveAgentCallbackOptions {
  /** The callback ID to resolve. */
  id: string;
  /** Values from the trigger source, keyed by variable name. */
  values: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Store Interface
// ---------------------------------------------------------------------------

/**
 * Agent Callback Store — persistence layer for deferred call_agent commands.
 * Implementations can use any backing store (CockroachDB, SQLite, in-memory, etc.).
 */
export interface AgentCallbackStore {
  create(options: CreateAgentCallbackOptions): Promise<string>;
  get(id: string): Promise<AgentCallbackEntry | null>;
  resolve(options: ResolveAgentCallbackOptions): Promise<AgentCallbackEntry>;
  cancel(id: string): Promise<boolean>;
  listPending(limit?: number): Promise<AgentCallbackEntry[]>;
}

// ---------------------------------------------------------------------------
// Template Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve {{trigger.variable}} references in an object tree.
 * Scans all string values and replaces {{trigger.x}} with the
 * corresponding value from triggerValues.
 *
 * Unresolved references are left as-is.
 */
export function resolveCallbackTemplates<T>(
  obj: T,
  triggerValues: Record<string, string>,
): T {
  if (typeof obj === 'string') {
    return obj.replace(/\{\{trigger\.(\w+)\}\}/g, (_match, varName: string) => {
      return triggerValues[varName] ?? `{{trigger.${varName}}}`;
    }) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveCallbackTemplates(item, triggerValues)) as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveCallbackTemplates(val, triggerValues);
    }
    return result as T;
  }
  return obj;
}

/**
 * Validate that all {{trigger.x}} references in a callback have
 * corresponding variables in the provided set.
 * Returns array of unresolved variable names, or empty if valid.
 */
export function validateCallbackTemplates(
  callback: Record<string, unknown>,
  knownVariables: string[],
): string[] {
  const definedVars = new Set(knownVariables);
  const referencedVars: string[] = [];

  const scanForRefs = (obj: unknown): void => {
    if (typeof obj === 'string') {
      const matches = obj.matchAll(/\{\{trigger\.(\w+)\}\}/g);
      for (const match of matches) {
        referencedVars.push(match[1]);
      }
    } else if (Array.isArray(obj)) {
      obj.forEach(scanForRefs);
    } else if (obj !== null && typeof obj === 'object') {
      Object.values(obj as Record<string, unknown>).forEach(scanForRefs);
    }
  };

  scanForRefs(callback);

  return referencedVars.filter((v) => !definedVars.has(v));
}
