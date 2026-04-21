import { describe, expect, test } from "bun:test";
import { createEventBus } from "./events.js";
import {
  type Logger,
  createConsoleJsonLogger,
  createNoopLogger,
  getDefaultLogger,
  setDefaultLogger,
} from "./logger.js";

function captureLogger(): { logger: Logger; records: unknown[] } {
  const records: unknown[] = [];
  const logger: Logger = {
    debug: (msg, fields) => records.push({ level: "debug", msg, fields }),
    info: (msg, fields) => records.push({ level: "info", msg, fields }),
    warn: (msg, fields) => records.push({ level: "warn", msg, fields }),
    error: (msg, fields) => records.push({ level: "error", msg, fields }),
    with: () => logger,
  };
  return { logger, records };
}

describe("createConsoleJsonLogger", () => {
  test("emits single-line JSON for each record", () => {
    const lines: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (line: string) => lines.push(line);
    console.log = (line: string) => lines.push(line);
    try {
      const logger = createConsoleJsonLogger();
      logger.info("hello", { foo: "bar" });
      logger.error("oops", { err: new Error("boom") });
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }

    expect(lines.length).toBe(2);
    for (const line of lines) {
      // Single line
      expect(line.includes("\n")).toBe(false);
      // Valid JSON
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const info = JSON.parse(lines[0]!);
    expect(info.level).toBe("info");
    expect(info.message).toBe("hello");
    expect(info.foo).toBe("bar");
    expect(typeof info.timestamp).toBe("string");

    const err = JSON.parse(lines[1]!);
    expect(err.level).toBe("error");
    expect(err.message).toBe("oops");
    expect(err.err.name).toBe("Error");
    expect(err.err.message).toBe("boom");
    expect(typeof err.err.stack).toBe("string");
  });

  test("with() merges base fields into child records", () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const root = createConsoleJsonLogger({ service: "atlas-api" });
      const child = root.with({ request_id: "abc123" });
      child.info("req", { method: "GET" });
    } finally {
      console.log = originalLog;
    }
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]!);
    expect(record.service).toBe("atlas-api");
    expect(record.request_id).toBe("abc123");
    expect(record.method).toBe("GET");
    expect(record.message).toBe("req");
  });

  test("handles non-serializable values without throwing", () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const logger = createConsoleJsonLogger();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      logger.info("cycle", { circular });
    } finally {
      console.log = originalLog;
    }
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]!);
    expect(record.serializer_error).toBe(true);
    expect(record.message).toBe("cycle");
  });

  test("serializes bigint and drops functions", () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const logger = createConsoleJsonLogger();
      logger.info("values", { big: 42n, fn: () => "ignored" });
    } finally {
      console.log = originalLog;
    }
    const record = JSON.parse(lines[0]!);
    expect(record.big).toBe("42");
    expect(record.fn).toBeUndefined();
  });
});

describe("createNoopLogger", () => {
  test("drops every record and with() returns self", () => {
    const noop = createNoopLogger();
    expect(() => {
      noop.debug("d");
      noop.info("i");
      noop.warn("w");
      noop.error("e", { err: new Error("ignored") });
    }).not.toThrow();
    const child = noop.with({ ctx: "x" });
    expect(typeof child.info).toBe("function");
  });
});

describe("default logger", () => {
  test("setDefaultLogger / getDefaultLogger round-trip", () => {
    const original = getDefaultLogger();
    const { logger, records } = captureLogger();
    try {
      setDefaultLogger(logger);
      getDefaultLogger().info("routed");
      expect(records.length).toBe(1);
    } finally {
      setDefaultLogger(original);
    }
  });
});

describe("createEventBus uses injected logger", () => {
  test("listener error is logged as a single structured record", async () => {
    const { logger, records } = captureLogger();
    const bus = createEventBus({ logger });
    bus.on("tool/call", () => {
      throw new Error("listener boom");
    });
    await bus.emit({
      type: "tool/call",
      agentPath: "@test",
      timestamp: Date.now(),
      tool: "demo",
      params: {},
    });
    expect(records.length).toBe(1);
    const rec = records[0] as {
      level: string;
      msg: string;
      fields: Record<string, unknown>;
    };
    expect(rec.level).toBe("error");
    expect(rec.msg).toBe("event_listener_error");
    expect(rec.fields.component).toBe("agents-sdk.events");
    expect(rec.fields.event_type).toBe("tool/call");
    expect(rec.fields.agent_path).toBe("@test");
    expect(rec.fields.error).toBeInstanceOf(Error);
  });

  test("listener errors never propagate", async () => {
    const bus = createEventBus({ logger: createNoopLogger() });
    bus.on("invoke", () => {
      throw new Error("nope");
    });
    await expect(
      bus.emit({
        type: "invoke",
        agentPath: "@test",
        timestamp: Date.now(),
        prompt: "hi",
      }),
    ).resolves.toBeUndefined();
  });

  test("falls back to module default logger when no option passed", async () => {
    const original = getDefaultLogger();
    const { logger, records } = captureLogger();
    try {
      setDefaultLogger(logger);
      const bus = createEventBus();
      bus.on("tool/call", () => {
        throw new Error("captured");
      });
      await bus.emit({
        type: "tool/call",
        agentPath: "@test",
        timestamp: Date.now(),
        tool: "demo",
        params: {},
      });
      expect(records.length).toBe(1);
    } finally {
      setDefaultLogger(original);
    }
  });
});
