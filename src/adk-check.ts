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

import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, writeFileSync, readFileSync, unlinkSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface CheckOptions {
  file?: string;
  code?: string;
  run?: boolean;
  noCheck?: boolean;
  configDir?: string;
}

const INLINE_PREAMBLE_CHECK = (
  `import "./.adk_types";\n` +
  `import { createAdk, createLocalFsStore } from "@slashfi/agents-sdk";\n` +
  `import { join } from "node:path";\n` +
  `import { homedir } from "node:os";\n` +
  `const adk = createAdk(\n` +
  `  createLocalFsStore(process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk")),\n` +
  `  { token: process.env.ATLAS_TOKEN ?? process.env.ADK_TOKEN ?? "" },\n` +
  `);\n`
);

const INLINE_PREAMBLE_RUN = (
  `import { createAdk, createLocalFsStore } from "@slashfi/agents-sdk";\n` +
  `import { join } from "node:path";\n` +
  `import { homedir } from "node:os";\n` +
  `const adk = createAdk(\n` +
  `  createLocalFsStore(process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk")),\n` +
  `  { token: process.env.ATLAS_TOKEN ?? process.env.ADK_TOKEN ?? "" },\n` +
  `);\n`
);

export async function adkCheck(opts: CheckOptions): Promise<{ ok: boolean; exitCode: number }> {
  const configDir = opts.configDir ?? process.env.ADK_CONFIG_DIR ?? join(homedir(), ".adk");
  const adkTypes = join(configDir, "adk.d.ts");
  const hasTypes = existsSync(adkTypes);
  const isInline = !!opts.code;

  // --no-check: skip typecheck, just run
  if (opts.noCheck && opts.run) {
    if (isInline) {
      const tmpFile = join(process.cwd(), ".adk_run.ts");
      writeFileSync(tmpFile, INLINE_PREAMBLE_RUN + opts.code);
      const r = spawnSync("bun", ["run", tmpFile], { cwd: process.cwd(), stdio: "inherit", env: process.env });
      try { unlinkSync(tmpFile); } catch {}
      return { ok: r.status === 0, exitCode: r.status ?? 1 };
    } else {
      const r = spawnSync("bun", ["run", resolve(opts.file!)], {
        cwd: dirname(resolve(opts.file!)), stdio: "inherit", env: process.env,
      });
      return { ok: r.status === 0, exitCode: r.status ?? 1 };
    }
  }

  if (!hasTypes) {
    console.error("\x1b[33m\u26a0\x1b[0m No adk.d.ts found. Run `adk sync` first to generate agent types.");
  }

  let cwd: string;
  let checkFile: string;
  let originalFile: string | undefined;
  const cleanup: string[] = [];

  if (isInline) {
    cwd = process.cwd();
    checkFile = join(cwd, ".adk_check.ts");
    writeFileSync(checkFile, INLINE_PREAMBLE_CHECK + opts.code);
    cleanup.push(checkFile);
  } else if (opts.file) {
    originalFile = resolve(opts.file);
    if (!existsSync(originalFile)) {
      console.error(`File not found: ${originalFile}`);
      return { ok: false, exitCode: 1 };
    }
    cwd = dirname(originalFile);
    checkFile = join(cwd, `.adk_check_${basename(originalFile)}`);
    const typesImport = hasTypes ? `import "./.adk_types";\n` : "";
    writeFileSync(checkFile, typesImport + readFileSync(originalFile, "utf-8"));
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
  const tsconfigFile = join(cwd, ".adk_tsconfig.json");
  writeFileSync(tsconfigFile, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      esModuleInterop: true,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: [basename(checkFile)],
  }));
  cleanup.push(tsconfigFile);

  // Find type checker
  const checker = findTypeChecker();

  // Type-check
  const result = spawnSync(checker.cmd, [...checker.args, "--project", tsconfigFile], {
    cwd, stdio: "inherit", env: process.env,
  });

  // Clean up
  for (const f of cleanup) { try { unlinkSync(f); } catch {} }

  if (result.status !== 0) {
    return { ok: false, exitCode: result.status ?? 1 };
  }

  console.error("\x1b[32m\u2713\x1b[0m Type check passed");

  // Run
  if (opts.run) {
    let runResult;
    if (isInline) {
      const tmpFile = join(cwd, ".adk_run.ts");
      writeFileSync(tmpFile, INLINE_PREAMBLE_RUN + opts.code);
      runResult = spawnSync("bun", ["run", tmpFile], { cwd, stdio: "inherit", env: process.env });
      try { unlinkSync(tmpFile); } catch {}
    } else {
      runResult = spawnSync("bun", ["run", originalFile!], { cwd, stdio: "inherit", env: process.env });
    }
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
