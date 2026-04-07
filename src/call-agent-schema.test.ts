import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  stripNulls,
  nullTolerant,
  zodToOpenAiJsonSchema,
  callAgentValidationSchema,
  callAgentRequestSchema,
  listAgentsValidationSchema,
} from "./call-agent-schema";

// ─────────────────────────────────────────────────────────────────────────────
// stripNulls
// ─────────────────────────────────────────────────────────────────────────────

describe("stripNulls", () => {
  test("converts null to undefined", () => {
    expect(stripNulls(null)).toBe(undefined);
  });

  test("passes through primitives", () => {
    expect(stripNulls("hello")).toBe("hello");
    expect(stripNulls(42)).toBe(42);
    expect(stripNulls(true)).toBe(true);
    expect(stripNulls(undefined)).toBe(undefined);
  });

  test("strips null from flat objects", () => {
    expect(stripNulls({ a: null, b: "hello" })).toEqual({ b: "hello" });
  });

  test("strips null from nested objects", () => {
    expect(stripNulls({ a: { b: null, c: "ok" }, d: null })).toEqual({
      a: { c: "ok" },
    });
  });

  test("strips null from arrays", () => {
    expect(stripNulls([1, null, 3])).toEqual([1, undefined, 3]);
  });

  test("handles deeply nested structures", () => {
    const input = {
      action: "execute_tool",
      path: "/agents/@test",
      tool: "my_tool",
      params: null,
      callerId: null,
      callerType: null,
      metadata: { nested: null, keep: "this" },
    };
    const result = stripNulls(input) as Record<string, unknown>;
    expect(result.action).toBe("execute_tool");
    expect(result.path).toBe("/agents/@test");
    expect(result.params).toBe(undefined);
    expect(result.callerId).toBe(undefined);
    expect(result.callerType).toBe(undefined);
    expect(result.metadata).toEqual({ keep: "this" });
  });

  test("handles empty objects and arrays", () => {
    expect(stripNulls({})).toEqual({});
    expect(stripNulls([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nullTolerant
// ─────────────────────────────────────────────────────────────────────────────

describe("nullTolerant", () => {
  const schema = z.object({
    name: z.string().optional(),
    count: z.number().optional(),
    tags: z.array(z.string()).optional(),
    nested: z
      .object({
        value: z.string().optional(),
      })
      .optional(),
  });

  test("original schema rejects null", () => {
    expect(() => schema.parse({ name: null })).toThrow();
    expect(() => schema.parse({ tags: null })).toThrow();
    expect(() => schema.parse({ count: null })).toThrow();
  });

  test("tolerant schema accepts null for optional string", () => {
    const tolerant = nullTolerant(schema);
    const result = tolerant.parse({ name: null });
    expect(result).toEqual({});
  });

  test("tolerant schema accepts null for optional array", () => {
    const tolerant = nullTolerant(schema);
    const result = tolerant.parse({ tags: null });
    expect(result).toEqual({});
  });

  test("tolerant schema accepts null for optional number", () => {
    const tolerant = nullTolerant(schema);
    const result = tolerant.parse({ count: null });
    expect(result).toEqual({});
  });

  test("tolerant schema accepts null for nested optional", () => {
    const tolerant = nullTolerant(schema);
    const result = tolerant.parse({ nested: { value: null } });
    expect(result).toEqual({ nested: {} });
  });

  test("tolerant schema still validates real values", () => {
    const tolerant = nullTolerant(schema);
    const result = tolerant.parse({
      name: "test",
      count: 5,
      tags: ["a", "b"],
    });
    expect(result).toEqual({ name: "test", count: 5, tags: ["a", "b"] });
  });

  test("tolerant schema still rejects invalid types", () => {
    const tolerant = nullTolerant(schema);
    expect(() => tolerant.parse({ name: 123 })).toThrow();
    expect(() => tolerant.parse({ count: "not a number" })).toThrow();
    expect(() => tolerant.parse({ tags: "not an array" })).toThrow();
  });

  test("all nulls at once", () => {
    const tolerant = nullTolerant(schema);
    const result = tolerant.parse({
      name: null,
      count: null,
      tags: null,
      nested: null,
    });
    expect(result).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// callAgentValidationSchema — real-world scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("callAgentValidationSchema", () => {
  test("accepts execute_tool with null optional fields (the original bug)", () => {
    const input = {
      request: {
        action: "execute_tool",
        path: "/agents/@librarian",
        tool: "search_skill",
        params: { query: "agent registry" },
        callerId: null,
        callerType: null,
        metadata: null,
      },
    };
    const result = callAgentValidationSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("accepts describe_tools with tools: null (the original bug)", () => {
    const input = {
      request: {
        action: "describe_tools",
        path: "/agents/@librarian",
        tools: null,
        callerId: null,
        callerType: null,
        metadata: null,
      },
    };
    const result = callAgentValidationSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("accepts invoke with null sessionId and branchAttributes", () => {
    const input = {
      request: {
        action: "invoke",
        path: "/agents/@compactor",
        prompt: "Hello",
        sessionId: null,
        branchAttributes: null,
        callerId: null,
        callerType: null,
        metadata: null,
      },
    };
    const result = callAgentValidationSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("accepts ask with null optional fields", () => {
    const input = {
      request: {
        action: "ask",
        path: "/agents/@worker",
        prompt: "What time is it?",
        sessionId: null,
        branchAttributes: null,
        callerId: null,
        callerType: null,
        metadata: null,
      },
    };
    const result = callAgentValidationSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("accepts list_resources with null optional fields", () => {
    const input = {
      request: {
        action: "list_resources",
        path: "/agents/@agent-fs",
        callerId: null,
        callerType: null,
        metadata: null,
      },
    };
    const result = callAgentValidationSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("accepts read_resources with null optional fields", () => {
    const input = {
      request: {
        action: "read_resources",
        path: "/agents/@agent-fs",
        uris: ["AUTH.md"],
        callerId: null,
        callerType: null,
        metadata: null,
      },
    };
    const result = callAgentValidationSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("still rejects truly invalid input", () => {
    const result = callAgentValidationSchema.safeParse({
      request: {
        action: "execute_tool",
        // missing required 'path' and 'tool'
      },
    });
    expect(result.success).toBe(false);
  });

  test("still rejects unknown action", () => {
    const result = callAgentValidationSchema.safeParse({
      request: {
        action: "unknown_action",
        path: "/agents/@test",
      },
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listAgentsValidationSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("listAgentsValidationSchema", () => {
  test("accepts all-null optional fields", () => {
    const result = listAgentsValidationSchema.parse({
      query: null,
      limit: null,
      cursor: null,
    });
    expect(result).toEqual({});
  });

  test("accepts mix of null and real values", () => {
    const result = listAgentsValidationSchema.parse({
      query: "notion",
      limit: null,
      cursor: null,
    });
    expect(result).toEqual({ query: "notion" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zodToOpenAiJsonSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("zodToOpenAiJsonSchema", () => {
  test("produces JSON schema with nullable optional fields", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const jsonSchema = zodToOpenAiJsonSchema(schema) as any;

    // Required field should be in required array
    expect(jsonSchema.required).toContain("required");
    // Optional field should also be required (openAi convention)
    expect(jsonSchema.required).toContain("optional");
    // Optional field should allow null
    const optProp = jsonSchema.properties.optional;
    expect(optProp.anyOf || optProp.type).toBeTruthy();
  });
});
