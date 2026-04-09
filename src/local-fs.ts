/**
 * Local filesystem FsStore for ADK CLI.
 *
 * Reads/writes files under ~/.adk/ (or $ADK_CONFIG_DIR).
 * Creates the directory on first write.
 *
 * Also manages the local encryption key at .encryption-key
 * (auto-generated on first use, never read by FsStore itself).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { FsStore } from "./agent-definitions/config.js";

const ENCRYPTION_KEY_FILE = ".encryption-key";

function defaultDir(): string {
  return process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk");
}

export function createLocalFsStore(dir?: string): FsStore {
  const base = dir ?? defaultDir();

  return {
    async readFile(path: string): Promise<string | null> {
      const full = join(base, path);
      if (!existsSync(full)) return null;
      return readFileSync(full, "utf-8");
    },

    async writeFile(path: string, content: string): Promise<void> {
      const full = join(base, path);
      const parent = dirname(full);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
      writeFileSync(full, content, "utf-8");
    },
  };
}

/**
 * Read the local encryption key from ~/.adk/.encryption-key.
 * Generates a random 32-byte hex key on first use.
 * Pass the env var ADK_ENCRYPTION_KEY to override.
 */
export function getLocalEncryptionKey(dir?: string): string {
  if (process.env.ADK_ENCRYPTION_KEY) {
    return process.env.ADK_ENCRYPTION_KEY;
  }

  const base = dir ?? defaultDir();
  const keyPath = join(base, ENCRYPTION_KEY_FILE);

  if (existsSync(keyPath)) {
    return readFileSync(keyPath, "utf-8").trim();
  }

  // Generate and persist
  if (!existsSync(base)) {
    mkdirSync(base, { recursive: true });
  }
  const key = randomBytes(32).toString("hex");
  writeFileSync(keyPath, key, { encoding: "utf-8", mode: 0o600 });
  return key;
}
