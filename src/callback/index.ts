/**
 * Agent Callback — Deferred call_agent execution.
 *
 * A callback is a call_agent command with typed input holes.
 * When the callback is resolved (e.g., via a trigger), template references
 * like {{input_name}} are resolved with the provided values
 * and the call_agent command is executed.
 *
 * Triggers (how inputs get collected) are a RUNTIME concept,
 * not part of this SDK. They are managed by deployment-specific
 * agents (e.g., @callbacks agent with slack_block_kit triggers).
 *
 * This module provides the unopinionated contract:
 * - Template resolution ({{input_name}} patterns)
 * - Store interface
 * - Validation utilities
 *
 * No platform-specific code (no Slack, no CockroachDB, no Atlas).
 */

// ---------------------------------------------------------------------------
// Callback Status
// ---------------------------------------------------------------------------

export type AgentCallbackStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'expired'
  | 'cancelled';

// ---------------------------------------------------------------------------
// Callback Entry
// ---------------------------------------------------------------------------

/**
 * A stored callback — a call_agent command waiting to be resolved.
 */
export interface AgentCallbackEntry {
  id: string;
  status: AgentCallbackStatus;
  /** The call_agent command. Params may contain {{input_name}} templates. */
  callback: Record<string, unknown>;
  /** Key-value attributes (e.g., creator info, trigger metadata, inputs schema). */
  attributes: Record<string, string>;
  createdAt: Date;
  completedAt?: Date;
}

// ---------------------------------------------------------------------------
// Create Options
// ---------------------------------------------------------------------------

export interface CreateAgentCallbackOptions {
  /** The call_agent command. May contain {{input_name}} template references in params. */
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
  /** Input values, keyed by variable name. */
  values: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Store Interface
// ---------------------------------------------------------------------------

/**
 * Minimal store contract for agent callbacks.
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
 * Resolve {{input_name}} and {{trigger.variable}} references in an object tree.
 * Scans all string values and replaces templates with values.
 *
 * Supports both new-style {{input_name}} and legacy {{trigger.variable}} patterns
 * for backwards compatibility.
 *
 * Unresolved references are left as-is.
 */
export function resolveCallbackTemplates<T>(
  obj: T,
  values: Record<string, string>,
): T {
  if (typeof obj === 'string') {
    // Resolve {{trigger.x}} (legacy) and {{x}} (new) patterns
    let result = obj.replace(/\{\{trigger\.(\w+)\}\}/g, (_match, varName: string) => {
      return values[varName] ?? `{{trigger.${varName}}}`;
    });
    result = result.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
      // Don't replace if it looks like a special template (e.g., {{this.callbackId}})
      if (varName === 'this') return _match;
      return values[varName] ?? `{{${varName}}}`;
    });
    return result as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveCallbackTemplates(item, values)) as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveCallbackTemplates(val, values);
    }
    return result as T;
  }
  return obj;
}

/**
 * Validate that all {{input_name}} and {{trigger.x}} references in a callback
 * have corresponding variables in the provided set.
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
      // Scan for both {{trigger.x}} (legacy) and {{x}} (new) patterns
      for (const match of obj.matchAll(/\{\{trigger\.(\w+)\}\}/g)) {
        referencedVars.push(match[1]);
      }
      for (const match of obj.matchAll(/\{\{(\w+)\}\}/g)) {
        if (match[1] !== 'this') {
          referencedVars.push(match[1]);
        }
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
