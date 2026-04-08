/**
 * Zod schema for SerializedAgentDefinition.
 *
 * Validates definition.json files at runtime — JSON imports have no type safety,
 * so this catches malformed definitions before they hit the registry.
 *
 * Used in:
 *   - registry.register() — validate on ingest
 *   - adk pack — validate after introspection
 *   - adk publish — validate before shipping
 */

import { z } from "zod";

// ============================================
// Tool Schema
// ============================================

export const SerializedToolSchema = z.object({
  name: z.string().min(1, "Tool name is required"),
  description: z.string(),
  inputSchema: z
    .record(z.unknown())
    .default({ type: "object", properties: {} }),
  outputSchema: z.object({}).passthrough().optional(),
});

// ============================================
// Agent Definition Schema
// ============================================

export const SerializedAgentDefinitionSchema = z
  .object({
    path: z.string().min(1, "Agent path is required"),
    name: z.string().min(1, "Agent name is required"),
    description: z.string().default(""),
    version: z.string().default("1.0.0"),
    visibility: z.enum(["public", "private"]).default("public"),
    auth: z.object({}).passthrough().optional(),
    serverSource: z.string().optional(),
    serverInfo: z
      .object({
        name: z.string(),
        version: z.string(),
      })
      .optional(),
    tools: z
      .array(SerializedToolSchema)
      .min(1, "At least one tool is required"),
    generatedAt: z.string().optional(),
    sdkVersion: z.string().optional(),
    // Allow additional fields (e.g., $defs from MCP introspection)
  })
  .passthrough();

// ============================================
// Validate
// ============================================

export type ValidationResult =
  | { ok: true; definition: z.infer<typeof SerializedAgentDefinitionSchema> }
  | { ok: false; errors: string[] };

/**
 * Validate a definition against the SerializedAgentDefinition schema.
 *
 * Returns either the validated definition or a list of human-readable errors.
 */
export function validateDefinition(input: unknown): ValidationResult {
  const result = SerializedAgentDefinitionSchema.safeParse(input);
  if (result.success) {
    return { ok: true, definition: result.data };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
  return { ok: false, errors };
}

/**
 * Validate and throw if invalid.
 * Use in register() and pack/publish where failure should be fatal.
 */
export function assertValidDefinition(input: unknown, context?: string): void {
  const result = validateDefinition(input);
  if (!result.ok) {
    const prefix = context
      ? `Invalid definition (${context})`
      : "Invalid definition";
    throw new Error(`${prefix}:\n  ${result.errors.join("\n  ")}`);
  }
}
