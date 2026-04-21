/**
 * ADK Init — Setup + skill injection for coding agents.
 *
 * Uses a preset-based system for scalability:
 * - Presets are JSON files in src/presets/ (one per coding agent)
 * - All use the agentskills.io SKILL.md standard
 * - Adding a new coding agent = adding one JSON file
 *
 * Non-interactive by design. The coding agent is the UX layer.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Adk } from "./config-store.js";

// ============================================
// Types
// ============================================

export interface Preset {
  name: string;
  defaultPath: string;
  filename: string;
}

export interface SkillTarget {
  preset: Preset;
  path: string;
}

// ============================================
// Preset Loading
// ============================================

// Presets are inlined to avoid import.meta/CJS compatibility issues.
// To add a new coding agent, add an entry here and a JSON file in src/presets/.
const BUILTIN_PRESETS: Preset[] = [
  { name: "claude", defaultPath: "~/.claude/skills", filename: "adk/SKILL.md" },
  { name: "cursor", defaultPath: ".agents/skills", filename: "adk/SKILL.md" },
  { name: "codex", defaultPath: ".agents/skills", filename: "adk/SKILL.md" },
  { name: "copilot", defaultPath: ".github/skills", filename: "adk/SKILL.md" },
  { name: "windsurf", defaultPath: ".windsurf/skills", filename: "adk/SKILL.md" },
  { name: "hermes", defaultPath: "~/.hermes/skills", filename: "adk/SKILL.md" },
];

let _presets: Map<string, Preset> | null = null;

export function loadPresets(): Map<string, Preset> {
  if (_presets) return _presets;
  _presets = new Map();
  for (const preset of BUILTIN_PRESETS) {
    _presets.set(preset.name, preset);
  }
  return _presets;
}

export function getPreset(name: string): Preset | undefined {
  return loadPresets().get(name);
}

export function listPresets(): Preset[] {
  return Array.from(loadPresets().values());
}

// ============================================
// Skill Content Templates
// ============================================

const ADK_SKILL_CONTENT = `adk is the Agent Development Kit CLI for connecting to remote APIs and tools.

Run \`adk --help\` for full usage. Run \`adk <command> --help\` for command-specific help.

## Quick Reference

\`adk ref add <name>\`           Install an agent (auto-resolves from public registry)
\`adk ref call <name> <tool>\`   Call a remote tool
\`adk ref auth <name>\`          Authenticate to a service
\`adk ref list\`                  List installed agents
\`adk ref inspect <name>\`       See available tools and resources
\`adk registry browse public\`   Browse all available agents

## Local Docs

Each installed agent has local docs at \`~/.adk/refs/<name>/\`:
  - \`tools/*.tool.json\` — full tool schemas (inputSchema, description)
  - \`skills/\` — usage guides and patterns
  - \`types/*.d.ts\` — TypeScript type definitions
`;

export function renderContent(
  content: string,
  meta: { name: string; description: string },
): string {
  return `---
name: ${meta.name}
description: ${meta.description}
---
${content}`;
}

// ============================================
// Target Parsing
// ============================================

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function parseTarget(value: string): SkillTarget {
  const colonIdx = value.indexOf(":");

  if (colonIdx === -1) {
    // Just a preset name
    const preset = getPreset(value);
    if (!preset) {
      const presetNames = Array.from(loadPresets().keys()).join(", ");
      throw new Error(`Unknown preset: ${value}. Available: ${presetNames}`);
    }
    return { preset, path: expandHome(preset.defaultPath) };
  }

  const key = value.slice(0, colonIdx);
  const path = value.slice(colonIdx + 1);

  // Check if key is a preset name (with custom path)
  const preset = getPreset(key);
  if (preset) {
    return { preset, path: expandHome(path || preset.defaultPath) };
  }

  const presetNames = Array.from(loadPresets().keys()).join(", ");
  throw new Error(`Unknown target: ${key}. Available presets: ${presetNames}`);
}

// ============================================
// Skill Installation
// ============================================

function ensureWrite(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, content, "utf-8");
}

export function installSkill(target: SkillTarget): string {
  const outputPath = join(resolve(target.path), target.preset.filename);
  const content = renderContent(ADK_SKILL_CONTENT, {
    name: "adk",
    description: "When connecting to APIs, calling remote tools, managing integrations, or the user asks about adk",
  });
  ensureWrite(outputPath, content);
  return outputPath;
}


// ============================================
// Init Command
// ============================================

const DEFAULT_REGISTRY_URL = "https://registry.slash.com";
const DEFAULT_REGISTRY_NAME = "public";

export async function runInit(adk: Adk, targets: SkillTarget[]): Promise<void> {
  // 1. Ensure default registry
  const registries = await adk.registry.list();
  const hasDefault = registries.some(
    (r) => r.url === DEFAULT_REGISTRY_URL || r.name === DEFAULT_REGISTRY_NAME,
  );
  if (!hasDefault) {
    await adk.registry.add({ url: DEFAULT_REGISTRY_URL, name: DEFAULT_REGISTRY_NAME });
    console.log(`\x1b[32m\u2713\x1b[0m Set default registry: ${DEFAULT_REGISTRY_URL}`);
  } else {
    console.log(`\x1b[32m\u2713\x1b[0m Default registry already configured: ${DEFAULT_REGISTRY_URL}`);
  }

  // 2. Install skills to targets
  if (targets.length === 0) {
    // Show available agents from the default registry
    try {
      const agents = await adk.registry.browse(DEFAULT_REGISTRY_NAME);
      if (agents.length > 0) {
        console.log(`\n${agents.length} agent(s) available on ${DEFAULT_REGISTRY_URL}:\n`);
        for (const a of agents) {
          const toolCount = a.toolCount ?? 0;
          console.log(`  ${a.path} (${toolCount} tools)`);
          if (a.description) console.log(`    ${a.description.slice(0, 120)}`);
          console.log();
        }
        console.log(`Connect one: adk ref add <name>`);
      }
    } catch {
      // Registry unreachable — skip browse
    }

    console.log(`\nTo install skills, re-run with targets:\n`);
    const presets = listPresets();
    for (const preset of presets) {
      console.log(`  adk init --target ${preset.name}`);
    }
    console.log(`\nCustom path: adk init --target <preset>:<path>`);
    console.log(`\nAsk the user which coding agents they use,`);
    console.log(`then run: adk init --target <preset> [--target <preset> ...]`);
    return;
  }

  for (const target of targets) {
    const outputPath = installSkill(target);
    console.log(`\x1b[32m\u2713\x1b[0m Installed adk skill \u2192 ${outputPath}`);
  }

  // 3. Save targets to config
  const config = await adk.readConfig();
  const targetStrings = targets.map((t) => {
    return t.path === expandHome(t.preset.defaultPath) ? t.preset.name : `${t.preset.name}:${t.path}`;
  });
  (config as any).targets = targetStrings;
  await adk.writeConfig(config);
  console.log(`\x1b[32m\u2713\x1b[0m Saved targets to config`);

  console.log(`\nDone! Your coding agents now know how to use adk.`);
  console.log(`Run \`adk init\` again anytime to refresh skills or add targets.`);
}
