/**
 * adk check / adk run
 *
 * Type-checks (and optionally runs) TypeScript files with auto-injected
 * ADK agent type augmentation. Writes a temp file next to the original
 * so module resolution works naturally from node_modules.
 *
 * Usage:
 *   adk check <file>          Type-check a file
 *   adk check -e "<code>"     Type-check inline code
 *   adk run <file>            Type-check + execute
 *   adk run -e "<code>"       Type-check + execute inline code
 */

import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface CheckOptions {
  file?: string;
  code?: string;
  run?: boolean;
  configDir?: string;
}

export async function adkCheck(opts: CheckOptions): Promise<{ ok: boolean; exitCode: number }> {
  const configDir = opts.configDir ?? process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk");
  const adkTypes = join(configDir, "adk.d.ts");
  const hasTypes = existsSync(adkTypes);

  if (!hasTypes) {
    console.error("\x1b[33m\u26a0\x1b[0m No adk.d.ts found. Run `adk sync` first to generate agent types.");
  }

  const preamble = hasTypes
    ? `import ${JSON.stringify(adkTypes.replace(/\.d\.ts$/, ""))};\n`
    : "";

  let checkFile: string;
  let originalFile: string | undefined;
  let cwd: string;

  if (opts.code) {
    // Inline: write temp file in cwd
    cwd = process.cwd();
    checkFile = join(cwd, "__adk_inline.ts");
    writeFileSync(checkFile, preamble + opts.code);
    originalFile = checkFile; // for run, execute the same file (bun ignores types)
  } else if (opts.file) {
    originalFile = resolve(opts.file);
    if (!existsSync(originalFile)) {
      console.error(`File not found: ${originalFile}`);
      return { ok: false, exitCode: 1 };
    }
    // Write temp file next to original so module resolution works
    cwd = dirname(originalFile);
    const name = `__adk_check_${basename(originalFile)}`;
    checkFile = join(cwd, name);
    writeFileSync(checkFile, preamble + readFileSync(originalFile, "utf-8"));
  } else {
    console.error('Usage: adk check <file> | adk check -e "<code>"');
    return { ok: false, exitCode: 1 };
  }

  // Find tsgo or tsc
  const checker = findTypeChecker();

  // Type-check
  const result = spawnSync(
    checker.cmd,
    [...checker.args, "--noEmit", checkFile],
    { cwd, stdio: "inherit", env: process.env },
  );

  // Clean up temp file
  try { unlinkSync(checkFile); } catch {}

  if (result.status !== 0) {
    return { ok: false, exitCode: result.status ?? 1 };
  }

  console.error("\x1b[32m\u2713\x1b[0m Type check passed");

  // Run mode: execute original file with bun
  if (opts.run) {
    const runResult = spawnSync("bun", ["run", originalFile!], {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    return { ok: runResult.status === 0, exitCode: runResult.status ?? 1 };
  }

  return { ok: true, exitCode: 0 };
}

function findTypeChecker(): { cmd: string; args: string[] } {
  // Prefer tsgo
  const tsgo = spawnSync("which", ["tsgo"], { stdio: "pipe" });
  if (tsgo.status === 0) return { cmd: "tsgo", args: [] };

  // npx tsgo
  const npxTsgo = spawnSync("npx", ["tsgo", "--version"], { stdio: "pipe", timeout: 5000 });
  if (npxTsgo.status === 0) return { cmd: "npx", args: ["tsgo"] };

  // Fallback: npx tsc
  return { cmd: "npx", args: ["tsc"] };
}
