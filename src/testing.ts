/**
 * Testing Utilities
 *
 * In-memory implementations of stores for use in unit tests.
 * These should NOT be used in production — use persistent stores instead.
 *
 * @example
 * ```typescript
 * import { createMemoryAuthStore, createInMemorySecretStore } from '@slashfi/agents-sdk/testing';
 *
 * const authStore = createMemoryAuthStore();
 * const secretStore = createInMemorySecretStore('test-encryption-key');
 * ```
 */

export { createMemoryAuthStore } from "./auth.js";
export { createInMemorySecretStore } from "./secrets.js";
