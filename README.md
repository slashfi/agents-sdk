# Agents SDK

SDK for building, connecting, and using AI agents. Includes the `adk` CLI for managing agent connections, installing skills for coding agents, and working with MCP servers.

## Copy this into your coding agent

```
Help me install the Agent Development Kit (adk) — a CLI that connects coding agents to remote
APIs and MCPs. It also installs skill files so you know how to use them.

Run this to install it:
curl -fsSL https://registry.slash.com/adk/install | sh

Then follow the printed instructions to set up skills and connect to agents.
```

---

## Quick Start

```bash
# Install via curl
curl -fsSL https://registry.slash.com/adk/install | sh

# Or via npm
npm install -g @slashfi/agents-sdk
```

```bash
# Set up skills for your coding agent (Claude Code, Cursor, Copilot, etc.)
adk init

# Connect to an agent from the public registry
adk ref add notion

# Browse available agents
adk registry browse public

# Call a tool
adk ref call notion notion-search '{"query": "hello"}'
```

---

## ADK CLI

The Agent Development Kit CLI. One tool for connecting to agents, managing skills, and the full agent definition lifecycle.

```bash
adk --help
```

### Commands Overview

| Command | Description |
|---------|-------------|
| `adk init` | Set up skills for coding agents (Claude, Cursor, Copilot, Codex, Windsurf, Hermes) |
| `adk ref add <name>` | Install an agent from a registry |
| `adk ref call <name> <tool>` | Call a tool on a connected agent |
| `adk ref auth <name>` | Authenticate to a service |
| `adk ref inspect <name>` | See available tools and resources |
| `adk registry browse <name>` | Browse agents on a registry |

---

## Working with Agents

### Setting Up Skills

`adk init` installs skill files for your coding agents. It auto-detects which agents you have installed and writes skill files in the standard YAML-frontmatter markdown format from [agentskills.io](https://agentskills.io).

```bash
# Auto-detect and set up all detected agents
adk init

# Target specific agents
adk init --target claude --target cursor --target codex

# Custom output path
adk init --target claude:./my-skills
```

Supported agents:

| Preset | Default Path | Format |
|--------|-------------|--------|
| `claude` | `~/.claude/skills` | SKILL.md |
| `cursor` | `.cursor/rules` | SKILL.md |
| `copilot` | `.github` | SKILL.md |
| `windsurf` | `.` | SKILL.md |
| `codex` | `.` | SKILL.md |
| `hermes` | `~/.hermes/skills` | SKILL.md |

### Connecting to Agents

Install agents from a registry. The public registry at `registry.slash.com` is configured by default.

```bash
# Install from the public registry (default)
adk ref add notion
adk ref add linear
adk ref add github

# Install from a specific registry
adk ref add myagent --registry internal

# Install from a direct URL
adk ref add myapi --url https://api.example.com/mcp
```

When you install a ref, the CLI:
1. Resolves the agent from the registry
2. Materializes tool schemas locally (`~/.adk/refs/<name>/tools/`)
3. Downloads skill files (`~/.adk/refs/<name>/skills/`)
4. Generates TypeScript types (`~/.adk/refs/<name>/types/`)

### Authentication

```bash
# Authenticate to a service (opens browser for OAuth, or prompts for API key)
adk ref auth notion

# Check auth status
adk ref auth-status notion

# Provide an API key directly
adk ref auth myapi --api-key sk-...
```

### Using Agents

```bash
# Call a tool
adk ref call notion notion-search '{"query": "meeting notes"}'

# Inspect available tools
adk ref inspect notion
adk ref inspect notion --full  # Include full input schemas

# List resources
adk ref resources notion

# Read a resource
adk ref read notion resource://docs/readme

# List all connected agents
adk ref list
```

### Managing Registries

```bash
# Add a registry
adk registry add https://registry.slash.com --name public

# Browse available agents
adk registry browse public
adk registry browse public --query "database"

# Inspect registry details
adk registry inspect public

# Test connectivity
adk registry test

# List configured registries
adk registry list
```

---

## Configuration

### consumer-config.json

All state lives in `~/.adk/consumer-config.json`. This is the "package.json" of the agent world — registries are like npm registries, refs are like dependencies.

```jsonc
{
  "registries": [
    { "url": "https://registry.slash.com", "name": "public", "status": "active" }
  ],
  "refs": [
    {
      "ref": "notion",
      "scheme": "registry",
      "sourceRegistry": { "url": "https://registry.slash.com", "agentPath": "notion" },
      "config": {
        "access_token": "secret:v1:aes-256-gcm:base64encodedciphertext..."
      }
    }
  ]
}
```

Config values prefixed with `secret:` are encrypted. Plain values are stored as-is.

### Encrypted Secrets

Secrets (OAuth tokens, API keys) are encrypted with AES-256-GCM before being stored in `consumer-config.json`. The encryption key lives at `~/.adk/.encryption-key` — a random 32-byte hex string auto-generated on first use.

```
~/.adk/
├── consumer-config.json    # Refs, registries, encrypted secrets
├── .encryption-key         # AES-256-GCM key (auto-generated)
└── refs/
    └── notion/
        ├── tools/              # Materialized tool schemas
        ├── skills/             # Downloaded skill files
        └── types/              # Generated TypeScript types
```

**Security note:** The `.encryption-key` file is currently readable by any process running as the same user, which means a coding agent can technically read it. We plan to lock this down with `0600` permissions and potentially OS keychain integration in a future release. For now, secrets are protected against casual inspection of the config file, but not against a determined local process.

Override the encryption key via environment variable:

```bash
export ADK_ENCRYPTION_KEY="your-custom-key"
```

---

## Creating a Registry Server

A registry is a collection of agents (MCP servers) hosted behind a single endpoint. Use `createAgentServer` to host your own:

```typescript
import { defineAgent, defineTool, createAgentRegistry, createAgentServer } from '@slashfi/agents-sdk';

// Define agents
const searchTool = defineTool({
  name: 'search',
  description: 'Search the database',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async ({ query }) => ({ results: [] }),
});

const searchAgent = defineAgent({
  path: 'search',
  entrypoint: 'A search agent',
  config: { name: 'Search', description: 'Search the database' },
  tools: [searchTool],
});

// Create registry and register agents
const registry = createAgentRegistry();
registry.register(searchAgent);

// Start the server
const server = createAgentServer(registry, { port: 3000 });
await server.start();
// Clients can now: adk registry add http://localhost:3000 --name my-registry
```

The server exposes:
- **MCP JSON-RPC** (`POST /`) — standard MCP protocol (tools/list, tools/call)
- **Agent discovery** (`GET /agents`) — list all public agents
- **Agent actions** (`POST /call`) — call_agent, list_agents
- **Health check** (`GET /health`)

Clients connect with:

```bash
adk registry add http://localhost:3000 --name my-registry
adk registry browse my-registry
adk ref add search --registry my-registry
```

---

## Proxy (Experimental)

Proxies let you forward `adk` operations to a remote server. This is useful when you want a central server to manage refs and registries on behalf of multiple users (e.g., a team server that holds shared credentials).

```bash
# Point adk at a remote server
adk proxy add https://my-team-server.com --name team --type mcp --default

# Now ref/registry operations are forwarded to the proxy
adk ref list        # forwarded to team server
adk ref add notion   # forwarded to team server
```

**Status:** Experimental. The basic add/remove/list flow works, but auth forwarding and multi-proxy routing are still being stabilized.

---

## Using ADK as an SDK

The `adk` CLI is built on a pluggable SDK. The core `createAdk(fs)` factory takes an `FsStore` interface — just `readFile` and `writeFile` — so you can back it with anything:

```typescript
import { createAdk } from '@slashfi/agents-sdk';
import type { FsStore } from '@slashfi/agents-sdk';

// Local filesystem (what the CLI uses)
import { createLocalFsStore } from '@slashfi/agents-sdk';
const adk = createAdk(createLocalFsStore());

// In-memory (for testing)
const memFs: FsStore = {
  _files: new Map<string, string>(),
  async readFile(path) { return this._files.get(path) ?? null; },
  async writeFile(path, content) { this._files.set(path, content); },
};
const testAdk = createAdk(memFs);

// S3-backed (for serverless)
const s3Fs: FsStore = {
  async readFile(path) { return getFromS3(`adk/${path}`); },
  async writeFile(path, content) { await putToS3(`adk/${path}`, content); },
};
const serverlessAdk = createAdk(s3Fs, { encryptionKey: process.env.ADK_KEY });
```

The `Adk` object exposes the same API the CLI uses:

```typescript
// Manage registries
await adk.registry.add({ url: 'https://registry.slash.com', name: 'public' });
const agents = await adk.registry.browse('public');

// Manage refs
await adk.ref.add({ ref: 'notion', scheme: 'registry', sourceRegistry: { url: '...', agentPath: 'notion' } });
const result = await adk.ref.call('notion', 'notion-search', { query: 'hello' });

// Read/write config directly
const config = await adk.readConfig();
```

This makes it straightforward to embed `adk` in a server, a CI pipeline, or any environment where the local filesystem isn't available.

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

Create a typed client from a `SerializedAgentDefinition`.

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
// GET  /agents — list public agents (HTTP discovery)
// MCP JSON-RPC (POST /) — list_agents, call_agent, etc.
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

```typescript
import { parseJsonc, readJsoncFile } from '@slashfi/agents-sdk';

const data = parseJsonc('{ "key": "value" /* comment */ }');
const file = readJsoncFile('./config.jsonc');
```

---

## Testing

```bash
# Unit tests
bun test

# E2E tarball round-trip
bun test/e2e-adk.ts

# Integration tests with local registry
npx verdaccio --config test/verdaccio-config.yaml --listen 4873
bun test/e2e-verdaccio.ts
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|--------|
| `ADK_CONFIG_DIR` | Config directory | `~/.adk` |
| `ADK_TOKEN` | Bearer token for authenticated registries | — |
| `ADK_ENCRYPTION_KEY` | Override encryption key | auto from `~/.adk/.encryption-key` |

---

## License

MIT
