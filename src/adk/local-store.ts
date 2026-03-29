/**
 * Local Store — Manages ~/adk/ directory, config, and encrypted secrets.
 *
 * Structure:
 *   ~/adk/
 *     config.json    — ConsumerConfig (registries + refs)
 *     secrets.json   — Encrypted secret values (AES-256-GCM)
 *     .key           — Encryption key (chmod 0600)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "../crypto.js";
import type { ConsumerConfig, RefEntry } from "../define-config.js";

// ============================================
// Paths
// ============================================

export function getAdkDir(): string {
  return process.env.ADK_HOME ?? join(homedir(), "adk");
}

export function getConfigPath(): string {
  return join(getAdkDir(), "config.json");
}

export function getSecretsPath(): string {
  return join(getAdkDir(), "secrets.json");
}

export function getKeyPath(): string {
  return join(getAdkDir(), ".key");
}

// ============================================
// Init
// ============================================

export interface InitOptions {
  registry?: string;
  force?: boolean;
}

const DEFAULT_REGISTRY = "https://registry.slash.com";

export async function initAdkDir(options: InitOptions = {}): Promise<{
  dir: string;
  created: { config: boolean; secrets: boolean; key: boolean };
}> {
  const dir = getAdkDir();
  const created = { config: false, secrets: false, key: false };

  // Create directory
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Config
  const configPath = getConfigPath();
  if (!existsSync(configPath) || options.force) {
    const config: ConsumerConfig = {
      registries: [options.registry ?? DEFAULT_REGISTRY],
      refs: [],
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    created.config = true;
  }

  // Secrets
  const secretsPath = getSecretsPath();
  if (!existsSync(secretsPath) || options.force) {
    writeFileSync(secretsPath, JSON.stringify({}, null, 2) + "\n");
    created.secrets = true;
  }

  // Key
  const keyPath = getKeyPath();
  if (!existsSync(keyPath) || options.force) {
    const key = randomBytes(32).toString("hex");
    writeFileSync(keyPath, key + "\n", { mode: 0o600 });
    // Ensure permissions even if umask interfered
    await chmod(keyPath, 0o600);
    created.key = true;
  }

  return { dir, created };
}

// ============================================
// Config Read/Write
// ============================================

export function readConfig(): ConsumerConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(
      `No config found at ${configPath}. Run 'adk init' first.`,
    );
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

export function writeConfig(config: ConsumerConfig): void {
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

// ============================================
// Encryption Key
// ============================================

export function readKey(): string {
  const keyPath = getKeyPath();
  if (!existsSync(keyPath)) {
    throw new Error(
      `No encryption key found at ${keyPath}. Run 'adk init' first.`,
    );
  }
  return readFileSync(keyPath, "utf-8").trim();
}

// ============================================
// Secrets Store
// ============================================

/** Raw secrets store: { [agentName]: { [key]: encryptedValue } } */
type SecretsFile = Record<string, Record<string, string>>;

function readSecretsFile(): SecretsFile {
  const path = getSecretsPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeSecretsFile(secrets: SecretsFile): void {
  writeFileSync(getSecretsPath(), JSON.stringify(secrets, null, 2) + "\n");
}

/**
 * Store a secret value for an agent (encrypted).
 */
export async function setSecret(
  agent: string,
  key: string,
  value: string,
): Promise<void> {
  const encKey = readKey();
  const encrypted = await encryptSecret(value, encKey);
  const secrets = readSecretsFile();
  if (!secrets[agent]) secrets[agent] = {};
  secrets[agent][key] = encrypted;
  writeSecretsFile(secrets);
}

/**
 * Read a secret value for an agent (decrypted).
 */
export async function getSecret(
  agent: string,
  key: string,
): Promise<string | null> {
  const secrets = readSecretsFile();
  const encrypted = secrets[agent]?.[key];
  if (!encrypted) return null;
  const encKey = readKey();
  return decryptSecret(encrypted, encKey);
}

/**
 * Get all secret keys for an agent (names only, not values).
 */
export function listSecretKeys(agent: string): string[] {
  const secrets = readSecretsFile();
  return Object.keys(secrets[agent] ?? {});
}

/**
 * Remove all secrets for an agent.
 */
export function removeSecrets(agent: string): void {
  const secrets = readSecretsFile();
  delete secrets[agent];
  writeSecretsFile(secrets);
}

// ============================================
// Ref Management
// ============================================

/**
 * Add a ref to the config.
 */
export function addRef(ref: RefEntry): void {
  const config = readConfig();
  if (!config.refs) config.refs = [];

  // Remove existing ref with same name
  const name = typeof ref === "string" ? ref : (ref.as ?? ref.ref);
  config.refs = config.refs.filter((r) => {
    const rName = typeof r === "string" ? r : (r.as ?? r.ref);
    return rName !== name;
  });

  config.refs.push(ref);
  writeConfig(config);
}

/**
 * Remove a ref from the config.
 */
export function removeRef(name: string): boolean {
  const config = readConfig();
  if (!config.refs) return false;
  const before = config.refs.length;
  config.refs = config.refs.filter((r) => {
    const rName = typeof r === "string" ? r : (r.as ?? r.ref);
    return rName !== name;
  });
  if (config.refs.length === before) return false;
  writeConfig(config);
  return true;
}

/**
 * List all configured refs with their names.
 */
export function listRefs(): Array<{ name: string; ref: string; hasSecrets: boolean }> {
  const config = readConfig();
  const secrets = readSecretsFile();
  return (config.refs ?? []).map((r) => {
    const ref = typeof r === "string" ? r : r.ref;
    const name = typeof r === "string" ? r : (r.as ?? r.ref);
    return { name, ref, hasSecrets: !!secrets[name] };
  });
}

/**
 * Check if adk is initialized.
 */
export function isInitialized(): boolean {
  return existsSync(getConfigPath()) && existsSync(getKeyPath());
}
