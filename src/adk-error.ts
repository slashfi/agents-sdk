/**
 * ADK Error — structured errors with agent-friendly messages.
 *
 * Every AdkError has:
 * - code: machine-readable error type
 * - message: short human/agent-readable summary
 * - hint: actionable next step
 * - details: full context for debugging
 * - errorId: unique ID for `adk error <id>` lookup
 */

let errorLog: AdkError[] = [];

function generateErrorId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "adk_err_";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export class AdkError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly summary: string;
  readonly details: Record<string, unknown>;
  readonly errorId: string;
  readonly timestamp: string;

  constructor(opts: {
    code: string;
    message: string;
    hint: string;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    // Compose the full agent-facing message into Error.message itself so
    // any caller that just reads `err.message` (LLM tool wrappers, generic
    // error logs, etc.) sees the hint too — not only callers that know to
    // call toAgentString(). Keep the bare message exposed as `summary` for
    // the rare caller that wants only the short form.
    const fullMessage = opts.hint
      ? `${opts.message}\nHint: ${opts.hint}`
      : opts.message;
    super(fullMessage);
    this.name = "AdkError";
    this.code = opts.code;
    this.hint = opts.hint;
    this.summary = opts.message;
    this.details = opts.details ?? {};
    this.errorId = generateErrorId();
    this.timestamp = new Date().toISOString();
    if (opts.cause) this.cause = opts.cause;

    errorLog.push(this);
    if (errorLog.length > 100) errorLog.shift();
  }

  /** Agent-friendly string: full message (already includes hint) + error ID */
  toAgentString(): string {
    return `${this.message}\nError ID: ${this.errorId}`;
  }

  /** Full debug output for `adk error <id>` */
  toDebugString(): string {
    return [
      `AdkError: ${this.summary}`,
      `  Code: ${this.code}`,
      `  Hint: ${this.hint}`,
      `  Error ID: ${this.errorId}`,
      `  Timestamp: ${this.timestamp}`,
      ...Object.entries(this.details).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
      this.stack ? `  Stack: ${this.stack}` : "",
    ].filter(Boolean).join("\n");
  }
}

/** Look up a recent error by ID */
export function getError(errorId: string): AdkError | null {
  return errorLog.find((e) => e.errorId === errorId) ?? null;
}

/** Get all recent errors */
export function getRecentErrors(): AdkError[] {
  return [...errorLog];
}

/** Clear error log (for tests) */
export function clearErrors(): void {
  errorLog = [];
}
