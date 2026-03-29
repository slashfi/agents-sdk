#!/usr/bin/env bun
/**
 * E2E test with Verdaccio: full registry round-trip
 *
 * Tests:
 *   1. adk pack v1 → npm publish → npm install → import
 *   2. adk pack v2 → npm publish → npm update → verify upgrade
 *   3. npm view versions → verify both listed
 *   4. npm install @agentdef/notion@1.0.0 → pinned install
 *
 * Requires verdaccio running on :4873
 *   npx verdaccio --config test/verdaccio-config.yaml --listen 4873
 */

import { execSync } from "node:child_process";
import {
	mkdirSync,
	writeFileSync,
	rmSync,
	existsSync,
	readFileSync,
} from "node:fs";
import { resolve } from "node:path";

const REGISTRY = "http://localhost:4873";
const TEST_DIR = "/tmp/adk-e2e-verdaccio";
const SDK_DIR = "/home/ec2-user/agents-sdk";

function run(cmd: string, cwd?: string): string {
	console.log(`\n> ${cmd}`);
	const result = execSync(cmd, {
		cwd: cwd || SDK_DIR,
		encoding: "utf-8",
		env: { ...process.env, npm_config_registry: REGISTRY },
	});
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
console.log("ADK E2E TEST (verdaccio)");
console.log("=".repeat(60));

if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
mkdirSync(TEST_DIR, { recursive: true });

// Verify verdaccio is running
try {
	execSync(`curl -sf ${REGISTRY}/-/ping`, { encoding: "utf-8" });
} catch {
	console.error(
		"Verdaccio not running. Start with:\n  npx verdaccio --config test/verdaccio-config.yaml --listen 4873",
	);
	process.exit(1);
}

// Get auth token (try login if user already exists)
let token: string;
try {
	const authResponse = execSync(
		`curl -s -X PUT ${REGISTRY}/-/user/org.couchdb.user:adktest -H 'Content-Type: application/json' -d '{"name":"adktest","password":"adktest1234"}'`,
		{ encoding: "utf-8" },
	);
	const authJson = JSON.parse(authResponse);
	token = authJson.token || authJson.ok;
	if (!token) {
		// User exists, login instead
		const loginResponse = execSync(
			`curl -s -X PUT ${REGISTRY}/-/user/org.couchdb.user:adktest -H 'Content-Type: application/json' -d '{"name":"adktest","password":"adktest1234"}'`,
			{ encoding: "utf-8" },
		);
		token = JSON.parse(loginResponse).token;
	}
} catch {
	console.error("Failed to get auth token from verdaccio");
	process.exit(1);
}
assert(!!token, `got auth token`);

// Write .npmrc for this test
writeFileSync(
	`${TEST_DIR}/.npmrc`,
	`registry=${REGISTRY}\n//localhost:4873/:_authToken=${token}\n`,
);
process.env.npm_config_userconfig = `${TEST_DIR}/.npmrc`;

// Load notion definition
const agentJson = readFileSync(
	"/home/ec2-user/repo/packages/atlas/agent-registry/src/agents/notion/definition.json",
	"utf-8",
);

// ============================================
// Step 1: Publish v1.0.0
// ============================================

console.log("\n--- Step 1: Pack + publish v1.0.0 ---");
writeFileSync(resolve(SDK_DIR, "agent.json"), agentJson);
run(`bun src/adk.ts pack --agent ./agent.json --out ${TEST_DIR}/dist-v1`);
run(
	`npm publish --access public --registry ${REGISTRY} --userconfig ${TEST_DIR}/.npmrc`,
	`${TEST_DIR}/dist-v1/notion`,
);

// Verify it's in the registry
const v1View = JSON.parse(
	run(`npm view @agentdef/notion --json --registry ${REGISTRY}`),
);
assert(v1View.name === "@agentdef/notion", "v1 published as @agentdef/notion");
assert(v1View.version === "1.0.0", "v1 version is 1.0.0");

// ============================================
// Step 2: Install v1.0.0 in a consumer
// ============================================

console.log("\n--- Step 2: Install v1.0.0 ---");
const consumerDir = `${TEST_DIR}/consumer`;
mkdirSync(consumerDir, { recursive: true });
writeFileSync(
	`${consumerDir}/package.json`,
	JSON.stringify(
		{
			name: "test-consumer",
			type: "module",
			version: "1.0.0",
			dependencies: { "@agentdef/notion": "^1.0.0" },
		},
		null,
		2,
	),
);
run(`npm install --registry ${REGISTRY}`, consumerDir);

// Verify import
writeFileSync(
	`${consumerDir}/test.mjs`,
	`
import def from "@agentdef/notion";
import { readFileSync } from "node:fs";
const meta = JSON.parse(readFileSync(new URL("./node_modules/@agentdef/notion/meta.json", import.meta.url), "utf-8"));
console.log(JSON.stringify({ tools: def.tools.length, version: def.version, hash: meta.hash }));
`,
);
const v1Result = JSON.parse(run("node test.mjs", consumerDir));
assert(v1Result.tools === 22, "v1 has 22 tools");
assert(v1Result.version === "1.0.0", "v1 definition version is 1.0.0");

// ============================================
// Step 3: Publish v1.1.0 (added + removed tools)
// ============================================

console.log("\n--- Step 3: Pack + publish v1.1.0 ---");
const defV2 = JSON.parse(agentJson);
defV2.version = "1.1.0";
defV2.tools.push({
	name: "test-new-tool",
	description: "Added in v1.1.0",
	inputSchema: {
		type: "object",
		properties: { query: { type: "string" } },
	},
});
const removedTool = defV2.tools.splice(0, 1)[0];
writeFileSync(
	resolve(SDK_DIR, "agent-v2.json"),
	JSON.stringify(defV2, null, 2),
);

const v2PackOutput = run(
	`bun src/adk.ts pack --agent ./agent-v2.json --out ${TEST_DIR}/dist-v2 --previous ./agent.json`,
);
assert(v2PackOutput.includes("Added: test-new-tool"), "diff shows added tool");
assert(
	v2PackOutput.includes(`Removed: ${removedTool.name}`),
	"diff shows removed tool",
);

run(
	`npm publish --access public --registry ${REGISTRY} --userconfig ${TEST_DIR}/.npmrc`,
	`${TEST_DIR}/dist-v2/notion`,
);

// ============================================
// Step 4: npm view versions
// ============================================

console.log("\n--- Step 4: Verify both versions in registry ---");
const versionsOutput = run(
	`npm view @agentdef/notion versions --json --registry ${REGISTRY}`,
);
const versions = JSON.parse(versionsOutput);
assert(
	Array.isArray(versions) && versions.includes("1.0.0"),
	"registry has 1.0.0",
);
assert(versions.includes("1.1.0"), "registry has 1.1.0");
console.log(`  Versions: ${versions.join(", ")}`);

// ============================================
// Step 5: npm update → gets v1.1.0
// ============================================

console.log("\n--- Step 5: npm update ---");
run(`npm update @agentdef/notion --registry ${REGISTRY}`, consumerDir);

const v2Result = JSON.parse(run("node test.mjs", consumerDir));
assert(v2Result.tools === 22, "v2 has 22 tools (added 1, removed 1)");
assert(v2Result.version === "1.1.0", "updated to v1.1.0");

// ============================================
// Step 6: pinned install of old version
// ============================================

console.log("\n--- Step 6: Pinned install @1.0.0 ---");
const pinnedDir = `${TEST_DIR}/pinned`;
mkdirSync(pinnedDir, { recursive: true });
writeFileSync(
	`${pinnedDir}/package.json`,
	JSON.stringify(
		{
			name: "test-pinned",
			type: "module",
			version: "1.0.0",
			dependencies: { "@agentdef/notion": "1.0.0" },
		},
		null,
		2,
	),
);
run(`npm install --registry ${REGISTRY}`, pinnedDir);

writeFileSync(
	`${pinnedDir}/test.mjs`,
	`
import def from "@agentdef/notion";
console.log(JSON.stringify({ tools: def.tools.length, version: def.version }));
`,
);
const pinnedResult = JSON.parse(run("node test.mjs", pinnedDir));
assert(pinnedResult.version === "1.0.0", "pinned to v1.0.0");
assert(pinnedResult.tools === 22, "pinned has 22 tools");

// ============================================
// Done
// ============================================

console.log("\n" + "=".repeat(60));
console.log("\x1b[32mALL TESTS PASSED\x1b[0m");
console.log("=".repeat(60));

// Cleanup SDK temp files
rmSync(resolve(SDK_DIR, "agent.json"), { force: true });
rmSync(resolve(SDK_DIR, "agent-v2.json"), { force: true });
