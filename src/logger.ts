/**
 * Logger — pluggable structured logger for the agents-sdk.
 *
 * The SDK emits errors and traces via this interface so consumers (e.g. atlas)
 * can route logs into their own observability stack. The default logger writes
 * single-line JSON to stdout/stderr, which keeps Datadog from splitting
 * multi-line stack traces into separate events.
 *
 * @example Inject your own logger
 * ```ts
 * const registry = createAgentRegistry({ logger: myStructuredLogger });
 * ```
 *
 * @example Disable all SDK logging
 * ```ts
 * const registry = createAgentRegistry({ logger: createNoopLogger() });
 * ```
 */

export type LogFields = Record<string, unknown>;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Return a child logger that merges the given fields into every record. */
  with(fields: LogFields): Logger;
}

/**
 * Replacer that expands Error objects into plain JSON-serializable fields
 * (name/message/stack/cause), and falls back to String() for other
 * non-serializable values so the logger never throws or drops the message.
 */
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause !== undefined ? { cause: value.cause } : {}),
    };
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return undefined;
  return value;
}

/**
 * Default logger: emits a single JSON line per record.
 *  - debug/info → stdout
 *  - warn/error → stderr
 *
 * Kept intentionally minimal. Hosts should replace this with their own
 * transport in production.
 */
export function createConsoleJsonLogger(base: LogFields = {}): Logger {
  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    const record = {
      level,
      timestamp: new Date().toISOString(),
      message,
      ...base,
      ...fields,
    };
    let line: string;
    try {
      line = JSON.stringify(record, errorReplacer);
    } catch {
      // Last-ditch fallback: if the payload can't be serialized, at least
      // emit the message so callers aren't flying blind.
      line = JSON.stringify({
        level,
        timestamp: new Date().toISOString(),
        message,
        serializer_error: true,
      });
    }
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    with: (fields) => createConsoleJsonLogger({ ...base, ...fields }),
  };
}

/** Logger that drops every record. Useful for silencing SDK output in tests. */
export function createNoopLogger(): Logger {
  const noop = (): void => {};
  const self: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    with: () => self,
  };
  return self;
}

/**
 * Module-level default logger. Hosts that want JSON output everywhere can
 * set this once at startup instead of threading a logger through every
 * factory call.
 */
let defaultLogger: Logger = createConsoleJsonLogger();

export function setDefaultLogger(logger: Logger): void {
  defaultLogger = logger;
}

export function getDefaultLogger(): Logger {
  return defaultLogger;
}
