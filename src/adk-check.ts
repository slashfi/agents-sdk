/**
 * adk check / adk run
 *
 * Type-checks (and optionally runs) TypeScript files with auto-injected
 * ADK agent type augmentation. Writes a temp file next to the original
 * so module resolution works naturally from node_modules.
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
  let tsconfigFile: string;
  let originalFile: string | undefined;
  let cwd: string;

  if (opts.code) {
    cwd = process.cwd();
    checkFile = join(cwd, ".adk_check.ts");
    writeFileSync(checkFile, preamble + opts.code);
    originalFile = checkFile;
  } else if (opts.file) {
    originalFile = resolve(opts.file);
    if (!existsSync(originalFile)) {
      console.error(`File not found: ${originalFile}`);
      return { ok: false, exitCode: 1 };
    }
    cwd = dirname(originalFile);
    checkFile = join(cwd, `.adk_check_${basename(originalFile)}`);
    writeFileSync(checkFile, preamble + readFileSync(originalFile, "utf-8"));
  } else {
    console.error('Usage: adk check <file> | adk check -e "<code>"');
    return { ok: false, exitCode: 1 };
  }

  // Write a minimal tsconfig next to the check file
  tsconfigFile = join(cwd, ".adk_tsconfig.json");
  writeFileSync(tsconfigFile, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      esModuleInterop: true,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: [basename(checkFile)],
  }, null, 2));

  // Find tsgo or tsc
  const checker = findTypeChecker();

  // Type-check
  const result = spawnSync(
    checker.cmd,
    [...checker.args, "--project", tsconfigFile],
    { cwd, stdio: "inherit", env: process.env },
  );

  // Clean up
  try { unlinkSync(checkFile); } catch {}
  try { unlinkSync(tsconfigFile); } catch {}

  if (result.status !== 0) {
    return { ok: false, exitCode: result.status ?? 1 };
  }

  console.error("\x1b[32m\u2713\x1b[0m Type check passed");

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
  const tsgo = spawnSync("which", ["tsgo"], { stdio: "pipe" });
  if (tsgo.status === 0) return { cmd: "tsgo", args: [] };

  const npxTsgo = spawnSync("npx", ["tsgo", "--version"], { stdio: "pipe", timeout: 5000 });
  if (npxTsgo.status === 0) return { cmd: "npx", args: ["tsgo"] };

  return { cmd: "npx", args: ["tsc"] };
}
