/**
 * adk check / adk run
 *
 * Type-checks (and optionally runs) TypeScript files with auto-injected
 * ADK agent type augmentation. No user config needed — the augmentation
 * import is prepended automatically.
 *
 * Usage:
 *   adk check <file>          Type-check a file
 *   adk check -e "<code>"     Type-check inline code
 *   adk run <file>            Type-check + execute
 *   adk run -e "<code>"       Type-check + execute inline code
 */

import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

export interface CheckOptions {
  /** File to check, or undefined if using inline code */
  file?: string;
  /** Inline code (-e flag) */
  code?: string;
  /** Also execute after type-check (adk run) */
  run?: boolean;
  /** ADK config dir (default: ~/.adk) */
  configDir?: string;
}

export async function adkCheck(opts: CheckOptions): Promise<{ ok: boolean; exitCode: number }> {
  const configDir = opts.configDir ?? process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk");
  const adkTypes = join(configDir, "adk.d.ts");
  const hasTypes = existsSync(adkTypes);

  if (!hasTypes) {
    console.error(
      "\x1b[33m\u26a0\x1b[0m No adk.d.ts found. Run `adk sync` first to generate agent types."
    );
  }

  // Resolve input
  let sourceFile: string; // the file tsgo actually checks
  let originalFile: string | undefined; // the user's original file (for `adk run`)
  let tmpDir: string | null = null;

  tmpDir = mkdtempSync(join(tmpdir(), "adk-"));

  if (opts.code) {
    // Inline code: write to temp file with augmentation preamble
    sourceFile = join(tmpDir, "__adk_inline.ts");
    const preamble = hasTypes
      ? `import ${JSON.stringify(adkTypes.replace(/\.d\.ts$/, ""))};\n`
      : "";
    writeFileSync(sourceFile, preamble + opts.code);
    originalFile = sourceFile;
  } else if (opts.file) {
    originalFile = resolve(opts.file);
    if (!existsSync(originalFile)) {
      console.error(`File not found: ${originalFile}`);
      return { ok: false, exitCode: 1 };
    }

    // Read original file and prepend the augmentation import
    const original = readFileSync(originalFile, "utf-8");
    sourceFile = join(tmpDir, "__adk_check.ts");
    const preamble = hasTypes
      ? `import ${JSON.stringify(adkTypes.replace(/\.d\.ts$/, ""))};\n`
      : "";
    writeFileSync(sourceFile, preamble + original);
  } else {
    console.error("Usage: adk check <file> | adk check -e \"<code>\"");
    return { ok: false, exitCode: 1 };
  }

  // Generate a tsconfig for the check
  const cwd = opts.file ? dirname(resolve(opts.file)) : process.cwd();
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      esModuleInterop: true,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
      baseUrl: cwd,
      paths: {
        // Ensure bare specifiers resolve from the user's project
        "*": [join(cwd, "node_modules", "*"), "*"],
      },
    },
    include: [sourceFile],
  };

  const tsconfigPath = join(tmpDir, "tsconfig.adk.json");
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

  // Find type checker: prefer tsgo, fall back to tsc
  const checker = findTypeChecker();

  // Run type-check
  const checkResult = spawnSync(checker.cmd, [...checker.args, "--project", tsconfigPath], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (checkResult.status !== 0) {
    cleanup(tmpDir);
    return { ok: false, exitCode: checkResult.status ?? 1 };
  }

  console.error("\x1b[32m\u2713\x1b[0m Type check passed");

  // If run mode, execute the original file with bun
  if (opts.run) {
    const runResult = spawnSync("bun", ["run", originalFile!], {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    cleanup(tmpDir);
    return { ok: runResult.status === 0, exitCode: runResult.status ?? 1 };
  }

  cleanup(tmpDir);
  return { ok: true, exitCode: 0 };
}

function findTypeChecker(): { cmd: string; args: string[] } {
  // Prefer tsgo
  const tsgoResult = spawnSync("which", ["tsgo"], { stdio: "pipe" });
  if (tsgoResult.status === 0) return { cmd: "tsgo", args: [] };

  // Fall back to npx tsgo, then npx tsc
  const npxTsgo = spawnSync("npx", ["tsgo", "--version"], { stdio: "pipe" });
  if (npxTsgo.status === 0) return { cmd: "npx", args: ["tsgo"] };

  return { cmd: "npx", args: ["tsc"] };
}

function cleanup(tmpDir: string | null) {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }
}
