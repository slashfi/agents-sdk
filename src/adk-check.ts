/**
 * adk check / adk run
 *
 * Type-checks (and optionally runs) TypeScript files with auto-injected
 * ADK agent type augmentation. Copies adk.d.ts next to the source so
 * module resolution works naturally.
 *
 *   adk check <file>              Type-check a file
 *   adk check -e "<code>"         Type-check inline code (adk instance auto-injected)
 *   adk run <file>                Type-check + execute
 *   adk run -e "<code>"           Type-check + execute inline (adk auto-injected)
 *   adk run --no-check <file>     Execute without type-checking
 *   adk run --no-check -e "code"  Execute inline without type-checking
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface CheckOptions {
  file?: string;
  code?: string;
  run?: boolean;
  noCheck?: boolean;
  configDir?: string;
}

/**
 * Resolve the absolute path to the @slashfi/agents-sdk package.
 * This ensures the preamble works regardless of the script's working directory,
 * since bare specifiers like "@slashfi/agents-sdk" may not resolve from arbitrary cwds.
 */
function resolveAgentsSdkPath(): string {
  try {
    // require.resolve gives us the main entry point, e.g.
    // /root/.bun/install/global/node_modules/@slashfi/agents-sdk/dist/index.js
    const resolved = require.resolve("@slashfi/agents-sdk");
    // Extract package root path
    const marker = "@slashfi/agents-sdk";
    const idx = resolved.indexOf(marker);
    if (idx !== -1) {
      return resolved.substring(0, idx + marker.length);
    }
    return "@slashfi/agents-sdk";
  } catch {
    return "@slashfi/agents-sdk";
  }
}

function makePreambleCheck(sdkPath: string): string {
  return `import "./.adk_types";\nimport { createAdk, createLocalFsStore } from "${sdkPath}";\nimport { join } from "node:path";\nimport { homedir } from "node:os";\nconst adk = createAdk(\n  createLocalFsStore(process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk")),\n  { token: process.env.ATLAS_TOKEN ?? process.env.ADK_TOKEN ?? "" },\n);\n`;
}

function makePreambleRun(sdkPath: string): string {
  return `import { createAdk, createLocalFsStore } from "${sdkPath}";\nimport { join } from "node:path";\nimport { homedir } from "node:os";\nconst adk = createAdk(\n  createLocalFsStore(process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk")),\n  { token: process.env.ATLAS_TOKEN ?? process.env.ADK_TOKEN ?? "" },\n);\n`;
}

/**
 * Create a run wrapper file that injects the adk preamble before the user's code.
 * Works for both inline (-e) and file mode.
 */
function writeRunWrapper(
  tmpFile: string,
  preamble: string,
  userCode: string,
): void {
  writeFileSync(tmpFile, preamble + userCode);
}

export async function adkCheck(
  opts: CheckOptions,
): Promise<{ ok: boolean; exitCode: number }> {
  const configDir =
    opts.configDir ?? process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk");
  const adkTypes = join(configDir, "adk.d.ts");
  const hasTypes = existsSync(adkTypes);
  const isInline = !!opts.code;
  const sdkPath = resolveAgentsSdkPath();
  const PREAMBLE_RUN = makePreambleRun(sdkPath);

  // --no-check: skip typecheck, just run
  if (opts.noCheck && opts.run) {
    const cwd = isInline ? process.cwd() : dirname(resolve(opts.file!));
    const userCode = isInline
      ? opts.code!
      : readFileSync(resolve(opts.file!), "utf-8");
    const tmpFile = join(cwd, ".adk_run.ts");
    writeRunWrapper(tmpFile, PREAMBLE_RUN, userCode);
    const r = spawnSync("bun", ["run", tmpFile], {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    try {
      unlinkSync(tmpFile);
    } catch {}
    return { ok: r.status === 0, exitCode: r.status ?? 1 };
  }

  if (!hasTypes) {
    console.error(
      "\x1b[33m\u26a0\x1b[0m No adk.d.ts found. Run `adk sync` first to generate agent types.",
    );
  }

  let cwd: string;
  let checkFile: string;
  let originalFile: string | undefined;
  const cleanup: string[] = [];
  const PREAMBLE_CHECK = makePreambleCheck(sdkPath);

  if (isInline) {
    cwd = process.cwd();
    checkFile = join(cwd, ".adk_check.ts");
    writeFileSync(checkFile, PREAMBLE_CHECK + opts.code);
    cleanup.push(checkFile);
  } else if (opts.file) {
    originalFile = resolve(opts.file);
    if (!existsSync(originalFile)) {
      console.error(`File not found: ${originalFile}`);
      return { ok: false, exitCode: 1 };
    }
    cwd = dirname(originalFile);
    checkFile = join(cwd, `.adk_check_${basename(originalFile)}`);
    // File mode: inject preamble so `adk` is typed and available
    const typesImport = hasTypes ? `import "./.adk_types";\n` : "";
    const preambleNoTypes = PREAMBLE_CHECK.replace(
      `import "./.adk_types";\n`,
      "",
    );
    writeFileSync(
      checkFile,
      typesImport + preambleNoTypes + readFileSync(originalFile, "utf-8"),
    );
    cleanup.push(checkFile);
  } else {
    console.error('Usage: adk check <file> | adk check -e "<code>"');
    return { ok: false, exitCode: 1 };
  }

  // Copy adk.d.ts locally so its import '@slashfi/agents-sdk' resolves
  if (hasTypes) {
    const typesFile = join(cwd, ".adk_types.d.ts");
    copyFileSync(adkTypes, typesFile);
    cleanup.push(typesFile);
  }

  // Write minimal tsconfig
  // Derive typeRoots from the SDK path so TypeScript finds @types/node
  // from the global install (e.g. /root/.bun/install/global/node_modules/@types)
  const sdkTypesRoot = (() => {
    const marker = "node_modules";
    const idx = sdkPath.indexOf(marker);
    if (idx !== -1) return join(sdkPath.substring(0, idx + marker.length), "@types");
    return undefined;
  })();
  const typeRoots = [
    join(cwd, "node_modules", "@types"),
    ...(sdkTypesRoot ? [sdkTypesRoot] : []),
  ];

  const tsconfigFile = join(cwd, ".adk_tsconfig.json");
  writeFileSync(
    tsconfigFile,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        esModuleInterop: true,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        typeRoots,
        types: ["node"],
      },
      include: [basename(checkFile)],
    }),
  );
  cleanup.push(tsconfigFile);

  // Find type checker
  const checker = findTypeChecker();

  if (!checker) {
    console.error(
      "\x1b[33m\u26a0\x1b[0m No TypeScript type checker found (tsgo or tsc). Skipping type check.",
    );
    for (const f of cleanup) {
      try {
        unlinkSync(f);
      } catch {}
    }

    // Still run if requested
    if (opts.run) {
      const userCode = isInline
        ? opts.code!
        : readFileSync(originalFile!, "utf-8");
      const tmpFile = join(cwd, ".adk_run.ts");
      writeRunWrapper(tmpFile, PREAMBLE_RUN, userCode);
      const r = spawnSync("bun", ["run", tmpFile], {
        cwd,
        stdio: "inherit",
        env: process.env,
      });
      try {
        unlinkSync(tmpFile);
      } catch {}
      return { ok: r.status === 0, exitCode: r.status ?? 1 };
    }
    return { ok: true, exitCode: 0 };
  }

  // Type-check
  const result = spawnSync(
    checker.cmd,
    [...checker.args, "--project", tsconfigFile],
    {
      cwd,
      stdio: "inherit",
      env: process.env,
    },
  );

  // Clean up
  for (const f of cleanup) {
    try {
      unlinkSync(f);
    } catch {}
  }

  if (result.status !== 0) {
    return { ok: false, exitCode: result.status ?? 1 };
  }

  console.error("\x1b[32m\u2713\x1b[0m Type check passed");

  // Run
  if (opts.run) {
    const userCode = isInline
      ? opts.code!
      : readFileSync(originalFile!, "utf-8");
    const tmpFile = join(cwd, ".adk_run.ts");
    writeRunWrapper(tmpFile, PREAMBLE_RUN, userCode);
    const runResult = spawnSync("bun", ["run", tmpFile], {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    try {
      unlinkSync(tmpFile);
    } catch {}
    return { ok: runResult.status === 0, exitCode: runResult.status ?? 1 };
  }

  return { ok: true, exitCode: 0 };
}

/**
 * Find a working TypeScript type checker.
 * Returns null if none found — callers should skip type checking gracefully.
 *
 * Checks:
 * 1. tsgo binary (fastest — native TypeScript compiler)
 * 2. npx tsgo (if installed as a package)
 * 3. tsc binary (standard TypeScript compiler, verified via --version)
 * 4. npx tsc — but ONLY if it's the real TypeScript compiler, not the
 *    unrelated `tsc` npm package that prints "This is not the tsc command
 *    you are looking for"
 */
function findTypeChecker(): { cmd: string; args: string[] } | null {
  // 1. tsgo binary
  const tsgo = spawnSync("which", ["tsgo"], { stdio: "pipe" });
  if (tsgo.status === 0) return { cmd: "tsgo", args: [] };

  // 2. npx tsgo
  const npxTsgo = spawnSync("npx", ["tsgo", "--version"], {
    stdio: "pipe",
    timeout: 5000,
  });
  if (npxTsgo.status === 0) return { cmd: "npx", args: ["tsgo"] };

  // 3. tsc binary (e.g. from `npm install -g typescript`)
  const tscWhich = spawnSync("which", ["tsc"], { stdio: "pipe" });
  if (tscWhich.status === 0) {
    // Verify it's the real TypeScript compiler, not the bogus `tsc` npm package
    const tscVersion = spawnSync("tsc", ["--version"], {
      stdio: "pipe",
      timeout: 5000,
    });
    const output = tscVersion.stdout?.toString() ?? "";
    if (tscVersion.status === 0 && output.includes("Version")) {
      return { cmd: "tsc", args: [] };
    }
  }

  // 4. npx tsc — validate it's actually TypeScript
  const npxTsc = spawnSync("npx", ["--no-install", "tsc", "--version"], {
    stdio: "pipe",
    timeout: 10000,
  });
  const npxOutput = npxTsc.stdout?.toString() ?? "";
  if (npxTsc.status === 0 && npxOutput.includes("Version")) {
    return { cmd: "npx", args: ["tsc"] };
  }

  // No type checker found
  return null;
}
