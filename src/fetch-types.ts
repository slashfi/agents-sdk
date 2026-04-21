/**
 * Structural `fetch` type that's compatible across Node (undici-backed) and
 * Bun (which extends the global fetch with extras like `preconnect`).
 *
 * Using `typeof globalThis.fetch` in options types causes type-errors when a
 * Node-typed fetch implementation (e.g. an undici.Agent-backed wrapper) is
 * passed in a codebase whose @types/bun is loaded. This structural subset is
 * the minimum surface the SDK actually uses and both runtimes satisfy it.
 */
export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
