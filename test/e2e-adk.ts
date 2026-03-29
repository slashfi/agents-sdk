#!/usr/bin/env bun
/**
 * E2E test: adk pack → npm pack → install tarball → import → verify
 *
 * No registry needed. Pure local.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DIR = "/tmp/adk-e2e-test";
const SDK_DIR = "/home/ec2-user/agents-sdk";

function run(cmd: string, cwd?: string): string {
  console.log(`\n> ${cmd}`);
  const result = execSync(cmd, { cwd: cwd || SDK_DIR, encoding: "utf-8" });
  console.log(result.trim());
  return result.trim();
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`\n\x1b[31m✗ FAIL: ${message}\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[32m✓ ${message}\x1b[0m`);
}

// ============================================
// Setup
// ============================================

console.log("\n" + "=".repeat(60));
console.log("ADK E2E TEST (tarball)");
console.log("=".repeat(60));

if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
mkdirSync(TEST_DIR, { recursive: true });

// Copy notion definition as agent.json
const agentJson = readFileSync(
  "/home/ec2-user/repo/packages/atlas/agent-registry/src/agents/notion/definition.json",
  "utf-8",
);
writeFileSync(resolve(SDK_DIR, "agent.json"), agentJson);

// ============================================
// Step 1: adk pack
// ============================================

console.log("\n--- Step 1: adk pack ---");
const packOutput = run(`bun src/adk.ts pack --agent ./agent.json --out ${TEST_DIR}/dist`);
assert(packOutput.includes("Packed @agentdef/notion"), "pack produced @agentdef/notion");
assert(packOutput.includes("Tools: 22"), "pack found 22 tools");

// Verify all files
for (const f of ["package.json", "agent.json", "meta.json", "index.js", "index.d.ts"]) {
  assert(existsSync(`${TEST_DIR}/dist/notion/${f}`), `${f} exists`);
}

// Verify package.json
const pkgJson = JSON.parse(readFileSync(`${TEST_DIR}/dist/notion/package.json`, "utf-8"));
assert(pkgJson.name === "@agentdef/notion", "name is @agentdef/notion");
assert(pkgJson.version === "1.0.0", "version is 1.0.0");
assert(pkgJson.exports["."].import === "./index.js", "exports correct");
assert(pkgJson.peerDependencies["@slashfi/agents-sdk"] === ">=0.21.0", "peer dep correct");

// Verify meta.json
const metaJson = JSON.parse(readFileSync(`${TEST_DIR}/dist/notion/meta.json`, "utf-8"));
assert(metaJson.toolCount === 22, "meta toolCount is 22");
assert(metaJson.hash.length === 8, "meta has 8-char hash");
assert(typeof metaJson.sizeBytes === "number", "meta has sizeBytes");
assert(typeof metaJson.generatedAt === "string", "meta has generatedAt");

// ============================================
// Step 2: npm pack → tarball
// ============================================

console.log("\n--- Step 2: npm pack (tarball) ---");
run("npm pack", `${TEST_DIR}/dist/notion`);

const tarballs = readdirSync(`${TEST_DIR}/dist/notion`).filter(f => f.endsWith(".tgz"));
assert(tarballs.length === 1, `found tarball: ${tarballs[0]}`);
const tarballPath = resolve(`${TEST_DIR}/dist/notion`, tarballs[0]);

// ============================================
// Step 3: install from tarball + import
// ============================================

console.log("\n--- Step 3: install tarball + import ---");

const consumerDir = `${TEST_DIR}/consumer`;
mkdirSync(consumerDir, { recursive: true });
writeFileSync(
  `${consumerDir}/package.json`,
  JSON.stringify({ name: "test-consumer", type: "module", version: "1.0.0" }, null, 2),
);

run(`npm install ${tarballPath}`, consumerDir);
assert(
  existsSync(`${consumerDir}/node_modules/@agentdef/notion/agent.json`),
  "agent.json in node_modules",
);
assert(
  existsSync(`${consumerDir}/node_modules/@agentdef/notion/meta.json`),
  "meta.json in node_modules",
);

// Write import test
writeFileSync(
  `${consumerDir}/test.mjs`,
  `
import definition from "@agentdef/notion";
import { readFileSync } from "node:fs";

// Also test direct JSON import
const meta = JSON.parse(readFileSync(
  new URL("./node_modules/@agentdef/notion/meta.json", import.meta.url),
  "utf-8"
));

const checks = [
  ["default export exists", definition != null],
  ["has name", typeof definition.name === "string"],
  ["path is notion", definition.path === "notion"],
  ["has tools array", Array.isArray(definition.tools)],
  ["22 tools", definition.tools.length === 22],
  ["tool has name", typeof definition.tools[0].name === "string"],
  ["tool has description", typeof definition.tools[0].description === "string"],
  ["tool has inputSchema", typeof definition.tools[0].inputSchema === "object"],
  ["meta.toolCount matches", meta.toolCount === definition.tools.length],
  ["meta.hash is string", typeof meta.hash === "string"],
];

let allPassed = true;
for (const [label, pass] of checks) {
  console.log(pass ? "\u2713 " + label : "\u2717 " + label);
  if (!pass) allPassed = false;
}

if (!allPassed) process.exit(1);
console.log("\\nAll import checks passed!");
`,
);

const importOutput = run("node test.mjs", consumerDir);
assert(importOutput.includes("All import checks passed"), "import + validate passed");

// ============================================
// Step 4: version diff
// ============================================

console.log("\n--- Step 4: version diff ---");

const def = JSON.parse(agentJson);
def.version = "1.1.0";
def.tools.push({
  name: "test-new-tool",
  description: "A test tool added for diff",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
});
// Remove one tool
const removedTool = def.tools.splice(0, 1)[0];
writeFileSync(resolve(SDK_DIR, "agent-v2.json"), JSON.stringify(def, null, 2));

const diffOutput = run(
  `bun src/adk.ts pack --agent ./agent-v2.json --out ${TEST_DIR}/dist2 --previous ./agent.json`,
);
assert(diffOutput.includes("Tools: 22"), "v2 has 22 tools (added 1, removed 1)");
assert(diffOutput.includes("Added: test-new-tool"), "diff shows added tool");
assert(diffOutput.includes(`Removed: ${removedTool.name}`), `diff shows removed tool: ${removedTool.name}`);

const meta2 = JSON.parse(readFileSync(`${TEST_DIR}/dist2/notion/meta.json`, "utf-8"));
assert(meta2.changes != null, "meta has changes");
assert(meta2.changes.toolsAdded.includes("test-new-tool"), "toolsAdded correct");
assert(meta2.changes.toolsRemoved.includes(removedTool.name), "toolsRemoved correct");
assert(meta2.changes.previousHash === metaJson.hash, "previousHash matches v1");

// ============================================
// Done
// ============================================

console.log("\n" + "=".repeat(60));
console.log("\x1b[32mALL TESTS PASSED\x1b[0m");
console.log("=".repeat(60));

// Cleanup
rmSync(resolve(SDK_DIR, "agent.json"), { force: true });
rmSync(resolve(SDK_DIR, "agent-v2.json"), { force: true });
rmSync(TEST_DIR, { recursive: true, force: true });
