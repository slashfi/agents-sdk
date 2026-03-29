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
 * Base trigger type. Extend this union to add new trigger sources.
 * Each trigger type defines how input variables are collected.
 */
export type AgentCallbackTrigger =
  | SlackBlockKitTrigger
  | WebhookTrigger;

export interface SlackBlockKitTrigger {
  type: 'slack_block_kit';
  /** Block Kit blocks to render. Input element action_ids define trigger variables. */
  blocks: Array<Record<string, unknown>>;
  /** Channel to send the form to. */
  channelId?: string;
  /** Thread timestamp to send in-thread. */
  threadTs?: string;
}

export interface WebhookTrigger {
  type: 'webhook';
  /** Optional URL path for the webhook. */
  path?: string;
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
  /** The call_agent command. Params may contain {{trigger.x}} templates. */
  callback: Record<string, unknown>;
  /** Trigger definition — how values are collected. */
  trigger?: AgentCallbackTrigger;
  /** Branch that created this callback. */
  creatorBranchId?: string;
  /** User this callback is for. */
  userId?: string;
  /** Resolved values from the trigger, keyed by variable name. */
  resolvedValues?: Record<string, string>;
  /** Callback expires after this time. */
  expiresAt?: Date;
  createdAt: Date;
  completedAt?: Date;
}

// ---------------------------------------------------------------------------
// Create Options
// ---------------------------------------------------------------------------

export interface CreateAgentCallbackOptions {
  /** The call_agent command. May contain {{trigger.x}} template references in params. */
  callback: Record<string, unknown>;
  /** Trigger definition. */
  trigger?: AgentCallbackTrigger;
  creatorBranchId?: string;
  userId?: string;
  /** TTL in milliseconds (default: implementation-defined). */
  ttlMs?: number;
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
  listByBranch(branchId: string, limit?: number): Promise<AgentCallbackEntry[]>;
  listPending(limit?: number): Promise<AgentCallbackEntry[]>;
  expireStale(): Promise<number>;
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
 * Extract defined variable names from a trigger.
 * For slack_block_kit: scans blocks for input elements and collects action_ids.
 */
export function extractTriggerVariables(
  trigger: AgentCallbackTrigger,
): string[] {
  if (trigger.type === 'slack_block_kit') {
    const vars: string[] = [];
    for (const block of trigger.blocks) {
      const element = block.element as Record<string, unknown> | undefined;
      if (element?.action_id && typeof element.action_id === 'string') {
        vars.push(element.action_id);
      }
    }
    return vars;
  }
  return [];
}

/**
 * Validate that all {{trigger.x}} references in a callback have
 * corresponding variables defined in the trigger.
 * Returns array of unresolved variable names, or empty if valid.
 */
export function validateCallbackTemplates(
  callback: Record<string, unknown>,
  trigger?: AgentCallbackTrigger,
): string[] {
  if (!trigger) return [];

  const definedVars = new Set(extractTriggerVariables(trigger));
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
