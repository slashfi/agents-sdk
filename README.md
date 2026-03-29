# Agents SDK

SDK for building, testing, and publishing AI agent definitions. Includes the `adk` CLI (Agent Development Kit) for working with MCP servers and the `@agentdef` npm package ecosystem.

## Installation

```bash
bun add @slashfi/agents-sdk
# or
npm install @slashfi/agents-sdk
```

## Overview

The SDK has two main parts:

1. **Runtime** — define agents, tools, registries, and servers programmatically
2. **ADK CLI** — introspect MCP servers, pack agent definitions, publish to npm

---

## ADK CLI

The Agent Development Kit CLI. One tool for the full agent definition lifecycle.

```bash
adk --help
```

### Commands

| Command | Description |
|---------|-------------|
| `adk introspect` | Connect to an MCP server → produce `agent.json` |
| `adk pack` | Generate a publishable `@agentdef/*` npm package from `agent.json` |
| `adk publish` | Pack + `npm publish` in one step |
| `adk codegen` | Full codegen from MCP server (TypeScript types, CLI, manifest) |
| `adk use` | Execute a tool on a generated agent |
| `adk list` | List all generated agents |

### Workflow

```bash
# 1. Introspect any MCP server → agent.json
adk introspect --server 'npx @notionhq/notion-mcp-server' --name notion

# 2. Review the generated agent.json (supports JSONC — comments allowed)
cat agent.json

# 3. Pack into a publishable npm package
adk pack
# ✅ Packed @agentdef/notion@1.0.0
#    Hash: ba845dfb
#    Tools: 22
#    Size: 28.7KB

# 4. Publish to npm
adk publish
# ✅ Published @agentdef/notion@1.0.0
```

### `adk introspect`

Connects to an MCP server via stdio, discovers all tools, deduplicates shared `$defs`, and writes a `SerializedAgentDefinition` as JSON.

```bash
adk introspect --server 'npx @notionhq/notion-mcp-server' --name notion
adk introspect --server 'npx @modelcontextprotocol/server-github' --name github --out ./definitions/github.json
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--server <cmd>` | MCP server command to run | required |
| `--name <name>` | Agent name | required |
| `--out <path>` | Output file path | `./<name>.json` |

### `adk pack`

Reads `agent.json` and generates a complete, publishable npm package:

```
@agentdef/notion/
├── package.json       ← generated from agent.json
├── agent.json         ← full SerializedAgentDefinition
├── meta.json          ← version metadata + diff from previous
├── index.js           ← re-export for ESM import
└── index.d.ts         ← typed as SerializedAgentDefinition
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--agent <path>` | Path to agent.json | `./agent.json` |
| `--out <dir>` | Output directory | `./dist` |
| `--scope <scope>` | npm scope | `@agentdef` |
| `--previous <path>` | Previous agent.json for version diff | — |

**Version diff** — pass `--previous` to generate a diff in `meta.json`:

```bash
adk pack --previous ./agent-v1.json
# ✅ Packed @agentdef/notion@1.1.0
#    Added: new-tool
#    Removed: deprecated-tool
#    Modified: search (inputSchema changed)
```

### `adk publish`

Packs + publishes to npm. Includes safety checks:

- **Duplicate version** — refuses with clear error + hint
- **Out-of-order version** — refuses to clobber `latest` tag
- **Auth failures** — hints to `npm login` or set `NPM_TOKEN`

```bash
adk publish
adk publish --dry-run
adk publish --tag beta
adk publish --registry http://localhost:4873
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Pack without publishing | — |
| `--tag <tag>` | npm dist-tag | `latest` |
| `--access <level>` | `public` or `restricted` | `public` |
| `--registry <url>` | npm registry URL | default npm |
| + all `pack` options | | |

**Error examples:**

```
✗ @agentdef/notion@1.0.0 already exists in registry

  Published versions: 1.0.0
  Hint: bump the version in agent.json, or use --tag to publish a pre-release
  Debug: cat /home/user/.npm/_logs/2026-03-29_debug.log | tail -40
```

```
⚠ Warning: publishing 4.0.0 which is older than latest (5.0.0)
  This will move the "latest" tag from 5.0.0 to 4.0.0.
  Use --tag <name> to publish without affecting latest.
Refusing to clobber latest tag. Use --tag <name> to publish 4.0.0 alongside 5.0.0.
```

---

## @agentdef Packages

Agent definitions published to npm under the `@agentdef` scope. Like `@types` for TypeScript, but for agent tool definitions.

### Consuming

```bash
npm install @agentdef/notion
```

```typescript
import definition from '@agentdef/notion';
// definition: SerializedAgentDefinition

console.log(definition.tools.length); // 22
console.log(definition.tools[0].name); // 'API-post-search'
```

Access metadata:

```typescript
import meta from '@agentdef/notion/meta.json';
// { hash, toolCount, sizeBytes, generatedAt, sdkVersion, changes? }
```

### agent.json Format

`agent.json` is the single source of truth. Supports JSONC (comments + trailing commas).

```jsonc
{
  // Agent identity
  "path": "notion",
  "name": "Notion MCP Server",
  "description": "Agent for Notion API",
  "version": "1.0.0",
  "visibility": "public",

  // MCP server source (for re-introspection)
  "serverSource": "npx @notionhq/notion-mcp-server",
  "serverInfo": { "name": "Notion MCP Server", "version": "1.6.2" },

  // Shared JSON Schema $defs (deduplicated across tools)
  "$defs": { ... },

  // Tool definitions
  "tools": [
    {
      "name": "API-post-search",
      "description": "Search Notion pages and databases",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" }
        }
      }
    }
    // ...
  ],

  // Generation metadata
  "generatedAt": "2026-03-29T08:40:04.913Z",
  "sdkVersion": "0.21.0"
}
```

### meta.json Format

```json
{
  "hash": "ba845dfb",
  "serverVersion": "1.6.2",
  "npmPackage": "npx @notionhq/notion-mcp-server",
  "toolCount": 22,
  "sizeBytes": 29373,
  "generatedAt": "2026-03-29T08:40:04.913Z",
  "sdkVersion": "0.21.0",
  "changes": {
    "previousHash": "a3f8c2de",
    "toolsAdded": ["new-tool"],
    "toolsRemoved": [],
    "toolsModified": ["search"],
    "schemaChanges": ["search: added property 'filter'"]
  }
}
```

---

## Runtime API

### `defineAgent(options)`

Create an agent definition.

```typescript
import { defineAgent, defineTool } from '@slashfi/agents-sdk';

const search = defineTool({
  name: 'search',
  description: 'Search for items',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' }
    },
    required: ['query']
  },
  execute: async (input) => {
    return { results: [] };
  }
});

const agent = defineAgent({
  path: '@my-agent',
  entrypoint: 'You are a helpful search assistant.',
  config: {
    name: 'Search Agent',
    description: 'An agent that can search'
  },
  tools: [search]
});
```

### `createClient(definition)`

Create a typed client from a `SerializedAgentDefinition`. Used for consuming `@agentdef` packages at runtime.

```typescript
import { createClient } from '@slashfi/agents-sdk';
import definition from '@agentdef/notion';

const client = createClient(definition);
const result = await client.callTool('API-post-search', { query: 'hello' });
```

### `createAgentRegistry(options?)`

Create an agent registry.

```typescript
import { createAgentRegistry } from '@slashfi/agents-sdk';

const registry = createAgentRegistry();
registry.register(agent);
registry.list();
registry.get('@my-agent');

const result = await registry.call({
  action: 'execute_tool',
  path: '@my-agent',
  tool: 'search',
  params: { query: 'hello' }
});
```

### `createAgentServer(registry, options?)`

HTTP server exposing the registry via JSON-RPC.

```typescript
import { createAgentServer } from '@slashfi/agents-sdk';

const server = createAgentServer(registry, { port: 3000 });
await server.start();
// POST /call  — execute agent actions
// GET  /list  — list agents
```

### `SerializedAgentDefinition`

The core type — a portable, JSON-serializable agent definition.

```typescript
import type { SerializedAgentDefinition } from '@slashfi/agents-sdk';

interface SerializedAgentDefinition {
  path: string;
  name: string;
  description?: string;
  version?: string;
  visibility?: 'public' | 'internal' | 'private';
  serverSource?: string;
  serverInfo?: { name?: string; version?: string };
  $defs?: Record<string, unknown>;
  tools: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  generatedAt?: string;
  sdkVersion?: string;
}
```

---

## JSONC Support

All JSON files read by `adk` support JSONC (JSON with Comments):

```jsonc
{
  // This is a comment
  "name": "notion",
  "tools": [
    /* multi-line
       comment */
    { "name": "search" }
  ],  // trailing commas are fine
}
```

```typescript
import { parseJsonc, readJsoncFile } from '@slashfi/agents-sdk';

const data = parseJsonc('{ "key": "value" /* comment */ }');
const file = readJsoncFile('./config.jsonc');
```

---

## Testing

### Unit tests (tarball round-trip)

```bash
bun test/e2e-adk.ts
```

Tests: pack → npm pack → install tarball → import → verify → version diff.

### Integration tests (verdaccio)

Full registry lifecycle with a local npm registry:

```bash
# Start verdaccio
npx verdaccio --config test/verdaccio-config.yaml --listen 4873

# Run tests (in another terminal)
bun test/e2e-verdaccio.ts
```

Tests: publish v1 → install → publish v2 → npm update → pinned install → version listing.

---

## Project Structure

```
src/
├── adk.ts                # ADK CLI entrypoint
├── pack.ts               # Pack + publish logic, version diff engine
├── introspect.ts         # MCP server introspection
├── jsonc.ts              # JSONC parser
├── codegen.ts            # Full codegen (TypeScript types, CLI, manifest)
├── serialized.ts         # SerializedAgentDefinition type
├── client.ts             # createClient()
├── define.ts             # defineAgent(), defineTool()
├── registry.ts           # Agent registry
├── server.ts             # HTTP server
├── index.ts              # Public API exports
└── ...

test/
├── e2e-adk.ts            # Tarball round-trip test
├── e2e-verdaccio.ts      # Full registry lifecycle test
└── verdaccio-config.yaml # Local registry config
```

---

## License

MIT
