# Agents SDK

SDK for building AI agents with tool definitions and JSON-RPC servers.

## Installation

```bash
bun add @slashfi/agents-sdk
# or
npm install @slashfi/agents-sdk
```

## Quick Start

```typescript
import {
  defineAgent,
  defineTool,
  createAgentRegistry,
  createAgentServer
} from '@slashfi/agents-sdk';

// Define a tool
const greet = defineTool({
  name: 'greet',
  description: 'Greet a user',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name to greet' }
    },
    required: ['name']
  },
  execute: async (input: { name: string }) => {
    return { message: `Hello, ${input.name}!` };
  }
});

// Define an agent
const agent = defineAgent({
  path: '@my-agent',
  entrypoint: 'You are a helpful assistant.',
  config: {
    name: 'My Agent',
    description: 'A helpful agent that can greet users'
  },
  tools: [greet]
});

// Create registry and register agent
const registry = createAgentRegistry();
registry.register(agent);

// Start HTTP server
const server = createAgentServer(registry, { port: 3000 });
await server.start();
```

## API

### `defineTool(options)`

Create a tool definition.

```typescript
const tool = defineTool({
  name: 'tool-name',
  description: 'What the tool does',
  inputSchema: {
    type: 'object',
    properties: {
      param: { type: 'string', description: 'Parameter description' }
    },
    required: ['param']
  },
  execute: async (input, ctx) => {
    // Tool implementation
    return result;
  }
});
```

### `defineAgent(options)`

Create an agent definition.

```typescript
const agent = defineAgent({
  path: '@agent-name',
  entrypoint: 'System prompt for the agent',
  config: {
    name: 'Agent Name',
    description: 'Agent description',
    supportedActions: ['execute_tool', 'describe_tools', 'load']
  },
  tools: [tool1, tool2]
});
```

### `createAgentRegistry(options?)`

Create an agent registry to manage agents.

```typescript
const registry = createAgentRegistry({
  defaultVisibility: 'internal' // 'public' | 'internal' | 'private'
});

registry.register(agent);
registry.list(); // Returns all registered agents
registry.get('@agent-name'); // Get agent by path

// Call an agent
const result = await registry.call({
  action: 'execute_tool',
  path: '@agent-name',
  tool: 'tool-name',
  params: { param: 'value' }
});
```

### `createAgentServer(registry, options?)`

Create an HTTP server exposing the registry.

```typescript
const server = createAgentServer(registry, {
  port: 3000,
  hostname: 'localhost',
  basePath: '/api',
  cors: true
});

await server.start();
// POST /api/call - Execute agent actions
// GET  /api/list - List agents

await server.stop();
```

## HTTP Endpoints

### POST /call

Execute an agent action.

**Request:**
```json
{
  "action": "execute_tool",
  "path": "@my-agent",
  "tool": "greet",
  "params": { "name": "World" }
}
```

**Response:**
```json
{
  "success": true,
  "result": { "message": "Hello, World!" }
}
```

**Actions:**
- `execute_tool` - Execute a specific tool
- `describe_tools` - Get tool schemas
- `load` - Get agent definition

### GET /list

List registered agents.

**Response:**
```json
{
  "success": true,
  "agents": [
    {
      "path": "@my-agent",
      "name": "My Agent",
      "description": "A helpful agent",
      "supportedActions": ["execute_tool", "describe_tools", "load"]
    }
  ]
}
```

## Access Control

Agents and tools support visibility levels:

- `public` - Anyone can access
- `internal` - Only other agents in the same registry
- `private` - Only the owning agent

```typescript
const agent = defineAgent({
  path: '@private-agent',
  entrypoint: '...',
  visibility: 'internal',
  allowedCallers: ['@trusted-agent'] // Explicit allowlist
});
```

## License

MIT
